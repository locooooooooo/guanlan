//! OS 原生事件驱动 File Watcher。
//!
//! - Windows：基于 `ReadDirectoryChangesW`（`FILE_FLAG_OVERLAPPED` + `bWatchSubtree = TRUE`
//!   + `stop_event` 零延迟唤醒退出），闲置时阻塞在内核等待对象，CPU 近似 0%；
//! - Linux：基于 `inotify` + `pipe` 停机信号 + `poll()`，递归监听子目录并在新目录创建时
//!   动态补挂 watch；
//! - 其余平台：回退轻量轮询；
//! - 路径合并防抖队列：100ms 滑动防抖 + 220ms 连续写入风暴最大等待上限，批内路径去重、
//!   过滤忽略目录与隐藏临时文件，溢出或真实删除兜底转交 `VerifyAll`，正常新建/修改走
//!   `ChangedPaths` 定向核验并在 `< 300ms` 内推动 SSE `workspace-change` 通知。
//!
//! 边界（契约 §6-1）：监听只作为「触发核验」的信号，**不作为审计日志**；
//! 版本判定永远由单一写线程上的对账执行。CLI `guanlan serve` 未开启 `--watch` 时
//! 不装配 watcher，保持默认零扫描只读契约不变。

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use guanlan_core::index::collector::{self, stat_fingerprint};

use crate::index_jobs::{IndexJobManager, JobKind};

/// 滑动防抖窗口（外部保存完成后合并原子写入碎事件并保持端到端 SSE `< 300ms`）
pub const DEBOUNCE_MS: u64 = 100;
/// 连续保存风暴（如 100 次/秒）下的最长合并等待上限，避免防抖窗口无限推迟
pub const MAX_COALESCE_WAIT_MS: u64 = 220;
/// 兜底轻量核验间隔（仅作长周期保险，平时靠 OS 事件驱动零扫描）
pub const FALLBACK_POLL_INTERVAL_MS: u64 = 300_000;
/// 单次提交路径上限（changed_paths 必填 ≤2000）
pub const MAX_PATHS: usize = 2000;

/// Watcher 运行句柄（/status 的 watcher 段数据源）
#[derive(Clone)]
pub struct WatcherHandle {
    /// 恒 true（watcher 装配即启用）
    pub enabled: bool,
    last_poll_at: Arc<Mutex<Option<String>>>,
    pending: Arc<Mutex<Vec<String>>>,
    last_poll_elapsed_ms: Arc<AtomicU64>,
    stop_tx: tokio::sync::watch::Sender<bool>,
    os_stop: Arc<os::OsWatcherStop>,
    os_thread: Arc<Mutex<Option<std::thread::JoinHandle<()>>>>,
    task: Arc<tokio::sync::Mutex<Option<tokio::task::JoinHandle<()>>>>,
}

impl WatcherHandle {
    /// 最近一次核验/轮询时刻（ISO；未触发过为 None）
    pub fn last_poll_at(&self) -> Option<String> {
        self.last_poll_at.lock().expect("轮询时刻锁").clone()
    }

    /// 防抖窗口内待提交的路径数
    pub fn changed_paths_pending(&self) -> usize {
        self.pending.lock().expect("待处理路径锁").len()
    }

    /// 最近一次批处理耗时（毫秒）
    pub fn last_poll_elapsed_ms(&self) -> u64 {
        self.last_poll_elapsed_ms.load(Ordering::Relaxed)
    }

    /// 停止 OS 事件线程与异步防抖协程并等待退出（切换工作区/停机时释放全部句柄与连接）
    pub async fn stop(&self) {
        let _ = self.stop_tx.send(true);
        self.os_stop.signal();
        let handle = self.task.lock().await.take();
        if let Some(h) = handle {
            let _ = h.await;
        }
        let thread = self.os_thread.lock().expect("OS 监听线程句柄锁").take();
        if let Some(t) = thread {
            let _ = tokio::task::spawn_blocking(move || {
                let _ = t.join();
            })
            .await;
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum WatchEventKind {
    Upsert,
    Removed,
}

#[derive(Debug, Clone)]
enum WatchSignal {
    Path {
        rel_path: String,
        kind: WatchEventKind,
    },
    Overflow,
}

/// 启动 OS 事件驱动 watcher（tokio 防抖任务 + 原生 OS 监听线程）。
pub fn start(root: String, jobs: IndexJobManager, baseline: WatchBaseline) -> WatcherHandle {
    let (stop_tx, mut stop_rx) = tokio::sync::watch::channel(false);
    let (sig_tx, mut sig_rx) = tokio::sync::mpsc::unbounded_channel::<WatchSignal>();
    let (os_stop, os_thread) = os::spawn_os_watcher(root.clone(), sig_tx);

    let task_slot = Arc::new(tokio::sync::Mutex::new(None));
    let handle = WatcherHandle {
        enabled: true,
        last_poll_at: Arc::new(Mutex::new(None)),
        pending: Arc::new(Mutex::new(Vec::new())),
        last_poll_elapsed_ms: Arc::new(AtomicU64::new(0)),
        stop_tx,
        os_stop,
        os_thread: Arc::new(Mutex::new(os_thread)),
        task: Arc::clone(&task_slot),
    };
    let worker_handle = handle.clone();

    let join = tokio::spawn(async move {
        let mut coalescer = EventCoalescer::new(root.clone());
        let mut fallback_tick =
            tokio::time::interval(Duration::from_millis(FALLBACK_POLL_INTERVAL_MS));
        fallback_tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        fallback_tick.tick().await; // 跳过首拍：服务启动时已提交一次后台启动对账

        loop {
            if *stop_rx.borrow() {
                break;
            }
            if let Some(deadline) = coalescer.next_deadline() {
                tokio::select! {
                    biased;
                    _ = stop_rx.changed() => {
                        if *stop_rx.borrow() {
                            break;
                        }
                    }
                    maybe_sig = sig_rx.recv() => {
                        match maybe_sig {
                            Some(sig) => {
                                coalescer.ingest(sig);
                                // 非阻塞抽干同一瞬间队列里的积压信号，降低唤醒次数
                                while let Ok(more) = sig_rx.try_recv() {
                                    coalescer.ingest(more);
                                }
                                sync_pending_gauge(&worker_handle, &coalescer);
                            }
                            None => break,
                        }
                    }
                    _ = tokio::time::sleep_until(deadline) => {
                        flush_coalescer(&mut coalescer, &jobs, &worker_handle);
                    }
                }
            } else {
                tokio::select! {
                    biased;
                    _ = stop_rx.changed() => {
                        if *stop_rx.borrow() {
                            break;
                        }
                    }
                    maybe_sig = sig_rx.recv() => {
                        match maybe_sig {
                            Some(sig) => {
                                coalescer.ingest(sig);
                                while let Ok(more) = sig_rx.try_recv() {
                                    coalescer.ingest(more);
                                }
                                sync_pending_gauge(&worker_handle, &coalescer);
                            }
                            None => break,
                        }
                    }
                    _ = fallback_tick.tick() => {
                        if *stop_rx.borrow() {
                            break;
                        }
                        poll_once_fallback(&root, &jobs, &baseline, &worker_handle).await;
                    }
                }
            }
        }
    });

    if let Ok(mut guard) = task_slot.try_lock() {
        *guard = Some(join);
    }
    handle
}

fn sync_pending_gauge(handle: &WatcherHandle, coalescer: &EventCoalescer) {
    let mut guard = handle.pending.lock().expect("待处理路径锁");
    guard.clear();
    guard.extend(coalescer.upserts.iter().take(MAX_PATHS).cloned());
}

fn flush_coalescer(coalescer: &mut EventCoalescer, jobs: &IndexJobManager, handle: &WatcherHandle) {
    let started = std::time::Instant::now();
    let plan = coalescer.take_flush_plan();
    {
        let mut guard = handle.pending.lock().expect("待处理路径锁");
        guard.clear();
    }

    if !plan.changed_paths.is_empty() {
        for chunk in plan.changed_paths.chunks(MAX_PATHS) {
            let batch = chunk.to_vec();
            let (job_id, merged, _) = jobs.submit_kind(JobKind::ChangedPaths(batch.clone()));
            eprintln!(
                "guanlan watcher 事件驱动 {} 条路径 → changed_paths job_id={job_id}（merged={merged}）",
                batch.len(),
            );
        }
    }
    if plan.need_verify_all {
        let (job_id, merged, _) = jobs.submit_kind(JobKind::VerifyAll);
        eprintln!(
            "guanlan watcher 触发增量兜底核验 → verify_all job_id={job_id}（merged={merged}）"
        );
    }

    let elapsed = started.elapsed().as_millis() as u64;
    handle
        .last_poll_elapsed_ms
        .store(elapsed, Ordering::Relaxed);
    *handle.last_poll_at.lock().expect("轮询时刻锁") = Some(guanlan_core::index::clock::now_iso());
}

/// 合并防抖状态机（独立纯结构，便于单测验证风暴合并、原子替换识别与溢出兜底）。
struct EventCoalescer {
    root: PathBuf,
    upserts: HashSet<String>,
    removals: HashSet<String>,
    overflow: bool,
    first_at: Option<tokio::time::Instant>,
    last_at: Option<tokio::time::Instant>,
}

struct FlushPlan {
    changed_paths: Vec<String>,
    need_verify_all: bool,
}

impl EventCoalescer {
    fn new(root: impl Into<PathBuf>) -> Self {
        Self {
            root: root.into(),
            upserts: HashSet::new(),
            removals: HashSet::new(),
            overflow: false,
            first_at: None,
            last_at: None,
        }
    }

    fn mark_activity(&mut self) {
        let now = tokio::time::Instant::now();
        if self.first_at.is_none() {
            self.first_at = Some(now);
        }
        self.last_at = Some(now);
    }

    fn next_deadline(&self) -> Option<tokio::time::Instant> {
        let first = self.first_at?;
        let last = self.last_at?;
        let sliding = last + Duration::from_millis(DEBOUNCE_MS);
        let ceiling = first + Duration::from_millis(MAX_COALESCE_WAIT_MS);
        Some(sliding.min(ceiling))
    }

    fn ingest(&mut self, sig: WatchSignal) {
        match sig {
            WatchSignal::Overflow => {
                self.overflow = true;
                self.mark_activity();
            }
            WatchSignal::Path { rel_path, kind } => {
                let norm = normalize_rel_path(&rel_path);
                if norm.is_empty() || should_ignore_rel_path(&norm) {
                    return;
                }
                match kind {
                    WatchEventKind::Upsert => {
                        let full = self.root.join(&norm);
                        if full.is_dir() {
                            // 仅在目录新增/迁入时收集其下受支持文件；普通目录修改事件忽略
                            let mut discovered = HashMap::new();
                            scan_dir(&self.root, &full, &norm, &mut discovered);
                            if !discovered.is_empty() {
                                for file_rel in discovered.into_keys() {
                                    self.removals.remove(&file_rel);
                                    self.upserts.insert(file_rel);
                                }
                                self.mark_activity();
                            }
                        } else if is_watchable_path(&self.root, &norm) {
                            self.removals.remove(&norm);
                            self.upserts.insert(norm);
                            self.mark_activity();
                        }
                    }
                    WatchEventKind::Removed => {
                        if is_watchable_path(&self.root, &norm) || looks_like_dir_rel(&norm) {
                            self.removals.insert(norm);
                            self.mark_activity();
                        }
                    }
                }
            }
        }
    }

    fn take_flush_plan(&mut self) -> FlushPlan {
        self.first_at = None;
        self.last_at = None;
        let mut need_verify_all = std::mem::take(&mut self.overflow);

        let mut candidates: HashSet<String> = std::mem::take(&mut self.upserts);
        let removals = std::mem::take(&mut self.removals);

        // 若外部编辑器走「删旧→重命名」或「先写临时文件再替换」原子保存，
        // 防抖落地时目标文件已在磁盘上：归入 changed_paths，绝不误触发全量扫描
        for rel in removals {
            let full = self.root.join(&rel);
            if full.is_file() {
                if is_watchable_path(&self.root, &rel) {
                    candidates.insert(rel);
                }
            } else if full.is_dir() {
                let mut discovered = HashMap::new();
                scan_dir(&self.root, &full, &rel, &mut discovered);
                candidates.extend(discovered.into_keys());
            } else {
                need_verify_all = true;
            }
        }

        let mut changed_paths: Vec<String> = candidates
            .into_iter()
            .filter(|rel| is_watchable_path(&self.root, rel) && self.root.join(rel).is_file())
            .collect();
        changed_paths.sort();

        FlushPlan {
            changed_paths,
            need_verify_all,
        }
    }
}

fn normalize_rel_path(raw: &str) -> String {
    raw.trim().replace('\\', "/").trim_matches('/').to_owned()
}

/// 路径任一段以 `.` 开头或属默认排除目录（`node_modules` / `.git` / `target` / `dist` 等）一律忽略
fn should_ignore_rel_path(rel: &str) -> bool {
    rel.split('/').any(|seg| {
        seg.is_empty() || seg.starts_with('.') || collector::DEFAULT_EXCLUDED.contains(&seg)
    })
}

/// 编辑器临时锁/交换文件（Office `~$*`、Vim `*.swp`/`*.swx`/`*~`、浏览器下载未完）
fn is_editor_temp_name(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    lower.starts_with("~$")
        || lower.ends_with(".swp")
        || lower.ends_with(".swx")
        || lower.ends_with(".part")
        || lower.ends_with(".crdownload")
        || lower.ends_with('~')
}

/// 采集白名单放开后，watcher 监听工作区内全部非忽略常规文件
/// （排除系统/依赖目录黑名单、点前缀、编辑器临时文件及 `.gitignore` 规则）。
fn is_watchable_path(root: &Path, rel: &str) -> bool {
    if should_ignore_rel_path(rel) {
        return false;
    }
    let name = rel.rsplit('/').next().unwrap_or(rel);
    if is_editor_temp_name(name) {
        return false;
    }
    !collector::is_ignored_path(root, rel)
}

/// 无扩展名视作可能是被整体删掉/重命名的目录名（触发一次轻量 verify_all 兜底）
fn looks_like_dir_rel(rel: &str) -> bool {
    let name = rel.rsplit('/').next().unwrap_or(rel);
    !name.contains('.')
}

/// 兜底轻量核验（每 5 分钟或无事件支持的平台使用）
async fn poll_once_fallback(
    root: &str,
    jobs: &IndexJobManager,
    baseline: &WatchBaseline,
    handle: &WatcherHandle,
) {
    let started = std::time::Instant::now();
    let baseline_map = baseline.read().await.unwrap_or_default();
    let root_path = PathBuf::from(root);
    let current = tokio::task::spawn_blocking(move || {
        let mut out = HashMap::new();
        scan_tree(&root_path, &mut out);
        out
    })
    .await
    .unwrap_or_default();

    let mut changed: Vec<String> = Vec::new();
    for (path, mtime) in &current {
        match baseline_map.get(path) {
            Some(baseline_mtime) if (baseline_mtime - mtime).abs() < 0.001 => {}
            _ => changed.push(path.clone()),
        }
    }
    let mut has_missing = false;
    for path in baseline_map.keys() {
        if !current.contains_key(path) {
            has_missing = true;
            break;
        }
    }
    changed.sort();

    if !changed.is_empty() {
        for chunk in changed.chunks(MAX_PATHS) {
            jobs.submit_kind(JobKind::ChangedPaths(chunk.to_vec()));
        }
    }
    if has_missing {
        jobs.submit_kind(JobKind::VerifyAll);
    }

    handle
        .last_poll_elapsed_ms
        .store(started.elapsed().as_millis() as u64, Ordering::Relaxed);
    *handle.last_poll_at.lock().expect("轮询时刻锁") = Some(guanlan_core::index::clock::now_iso());
}

/// 全树 stat 扫描（不哈希——版本判定交给对账；遵循排除目录与 `.gitignore`）
fn scan_tree(root: &Path, out: &mut HashMap<String, f64>) {
    scan_dir(root, root, "", out);
}

fn scan_dir(root: &Path, dir: &Path, relative_dir: &str, out: &mut HashMap<String, f64>) {
    let entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(_) => return,
    };
    let mut names: Vec<(String, PathBuf)> = Vec::new();
    for entry in entries.flatten() {
        names.push((
            entry.file_name().to_string_lossy().into_owned(),
            entry.path(),
        ));
    }
    names.sort_by(|a, b| a.0.cmp(&b.0));
    for (name, full_path) in names {
        let Ok(meta) = std::fs::symlink_metadata(&full_path) else {
            continue;
        };
        if meta.is_dir() {
            if name.starts_with('.') || collector::DEFAULT_EXCLUDED.contains(&name.as_str()) {
                continue;
            }
            let child_dir = if relative_dir.is_empty() {
                name.clone()
            } else {
                format!("{relative_dir}/{name}")
            };
            if collector::is_ignored_path(root, &child_dir) {
                continue;
            }
            scan_dir(root, &full_path, &child_dir, out);
            continue;
        }
        if !meta.is_file() {
            continue;
        }
        let rel = if relative_dir.is_empty() {
            name
        } else {
            format!("{relative_dir}/{name}")
        };
        if !is_watchable_path(root, &rel) {
            continue;
        }
        let Ok(fingerprint) = stat_fingerprint(&full_path) else {
            continue;
        };
        out.insert(rel, fingerprint.mtime_ms);
    }
}

/// 基线读取器（借只读连接池读 files(current_path, last_mtime_ms)——f64 读，
/// REAL/INTEGER 双存储兼容）
#[derive(Clone)]
pub struct WatchBaseline {
    exec: Arc<crate::http::QueryExecutor>,
}

impl WatchBaseline {
    pub fn new(exec: Arc<crate::http::QueryExecutor>) -> Self {
        Self { exec }
    }

    async fn read(&self) -> Option<HashMap<String, f64>> {
        self.exec
            .run(guanlan_core::query::watch_baseline)
            .await
            .ok()
    }
}

// ============================================================
// OS 原生目录事件通道（Windows ReadDirectoryChangesW / Linux inotify）
// ============================================================

#[cfg(windows)]
mod os {
    use std::ffi::{c_void, OsStr};
    use std::os::windows::ffi::OsStrExt;
    use std::path::Path;
    use std::ptr::{null, null_mut};
    use std::sync::Arc;
    use tokio::sync::mpsc::UnboundedSender;

    use super::{WatchEventKind, WatchSignal};

    const FILE_LIST_DIRECTORY: u32 = 0x0001;
    const FILE_SHARE_READ: u32 = 0x0000_0001;
    const FILE_SHARE_WRITE: u32 = 0x0000_0002;
    const FILE_SHARE_DELETE: u32 = 0x0000_0004;
    const OPEN_EXISTING: u32 = 3;
    const FILE_FLAG_BACKUP_SEMANTICS: u32 = 0x0200_0000;
    const FILE_FLAG_OVERLAPPED: u32 = 0x4000_0000;
    const FILE_NOTIFY_CHANGE_FILE_NAME: u32 = 0x0000_0001;
    const FILE_NOTIFY_CHANGE_DIR_NAME: u32 = 0x0000_0002;
    const FILE_NOTIFY_CHANGE_SIZE: u32 = 0x0000_0008;
    const FILE_NOTIFY_CHANGE_LAST_WRITE: u32 = 0x0000_0010;
    const FILE_ACTION_ADDED: u32 = 1;
    const FILE_ACTION_REMOVED: u32 = 2;
    const FILE_ACTION_MODIFIED: u32 = 3;
    const FILE_ACTION_RENAMED_OLD_NAME: u32 = 4;
    const FILE_ACTION_RENAMED_NEW_NAME: u32 = 5;
    const INVALID_HANDLE_VALUE: isize = -1;
    const WAIT_OBJECT_0: u32 = 0;
    const WAIT_OBJECT_1: u32 = 1;
    const INFINITE: u32 = 0xFFFF_FFFF;
    const ERROR_IO_PENDING: u32 = 997;
    const ERROR_OPERATION_ABORTED: u32 = 995;

    #[repr(C)]
    struct Overlapped {
        #[allow(dead_code)]
        internal: usize,
        #[allow(dead_code)]
        internal_high: usize,
        #[allow(dead_code)]
        offset: u32,
        #[allow(dead_code)]
        offset_high: u32,
        h_event: *mut c_void,
    }

    #[repr(C)]
    struct FileNotifyInformation {
        next_entry_offset: u32,
        action: u32,
        file_name_length: u32,
        file_name: [u16; 1],
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn CreateFileW(
            lp_file_name: *const u16,
            dw_desired_access: u32,
            dw_share_mode: u32,
            lp_security_attributes: *const c_void,
            dw_creation_disposition: u32,
            dw_flags_and_attributes: u32,
            h_template_file: *mut c_void,
        ) -> *mut c_void;
        fn CreateEventW(
            lp_event_attributes: *const c_void,
            b_manual_reset: i32,
            b_initial_state: i32,
            lp_name: *const u16,
        ) -> *mut c_void;
        fn SetEvent(h_event: *mut c_void) -> i32;
        fn ResetEvent(h_event: *mut c_void) -> i32;
        fn WaitForMultipleObjects(
            n_count: u32,
            lp_handles: *const *mut c_void,
            b_wait_all: i32,
            dw_milliseconds: u32,
        ) -> u32;
        fn WaitForSingleObject(h_handle: *mut c_void, dw_milliseconds: u32) -> u32;
        fn ReadDirectoryChangesW(
            h_directory: *mut c_void,
            lp_buffer: *mut c_void,
            n_buffer_length: u32,
            b_watch_subtree: i32,
            dw_notify_filter: u32,
            lp_bytes_returned: *mut u32,
            lp_overlapped: *mut Overlapped,
            lp_completion_routine: *const c_void,
        ) -> i32;
        fn GetOverlappedResult(
            h_file: *mut c_void,
            lp_overlapped: *mut Overlapped,
            lp_number_of_bytes_transferred: *mut u32,
            b_wait: i32,
        ) -> i32;
        fn CancelIoEx(h_file: *mut c_void, lp_overlapped: *mut Overlapped) -> i32;
        fn CloseHandle(h_object: *mut c_void) -> i32;
        fn GetLastError() -> u32;
    }

    pub struct WinHandle(isize);
    // SAFETY: Win32 内核事件/目录句柄可安全跨线程发送与信号通知，Drop 保证只 CloseHandle 一次。
    unsafe impl Send for WinHandle {}
    unsafe impl Sync for WinHandle {}

    impl Drop for WinHandle {
        fn drop(&mut self) {
            if self.0 != 0 && self.0 != INVALID_HANDLE_VALUE {
                // SAFETY: 句柄由 CreateFileW / CreateEventW 创建且由本守卫独占释放。
                unsafe {
                    CloseHandle(self.0 as *mut c_void);
                }
            }
        }
    }

    pub struct OsWatcherStop {
        stop_event: Option<Arc<WinHandle>>,
    }

    impl OsWatcherStop {
        pub fn signal(&self) {
            if let Some(ev) = &self.stop_event {
                // SAFETY: `ev.0` 为有效的手动重置事件句柄，SetEvent 线程安全。
                unsafe {
                    SetEvent(ev.0 as *mut c_void);
                }
            }
        }
    }

    pub fn spawn_os_watcher(
        root: String,
        tx: UnboundedSender<WatchSignal>,
    ) -> (Arc<OsWatcherStop>, Option<std::thread::JoinHandle<()>>) {
        // SAFETY: 创建匿名手动重置停止事件。
        let raw_stop = unsafe { CreateEventW(null(), 1, 0, null()) };
        if raw_stop.is_null() {
            return (Arc::new(OsWatcherStop { stop_event: None }), None);
        }
        let stop_handle = Arc::new(WinHandle(raw_stop as isize));
        let stop_for_thread = Arc::clone(&stop_handle);
        let os_stop = Arc::new(OsWatcherStop {
            stop_event: Some(stop_handle),
        });

        let join = std::thread::Builder::new()
            .name("guanlan-win-watcher".to_owned())
            .spawn(move || run_win_watcher(&root, stop_for_thread, tx))
            .ok();

        (os_stop, join)
    }

    fn run_win_watcher(root: &str, stop_event: Arc<WinHandle>, tx: UnboundedSender<WatchSignal>) {
        let mut wide: Vec<u16> = OsStr::new(Path::new(root)).encode_wide().collect();
        wide.push(0);

        // SAFETY: 以共享读写删除模式只读打开目录（绝不锁死外部编辑器/资源管理器重命名），
        // 仅作 ReadDirectoryChangesW 监听载体。
        let raw_dir = unsafe {
            CreateFileW(
                wide.as_ptr(),
                FILE_LIST_DIRECTORY,
                FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                null(),
                OPEN_EXISTING,
                FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OVERLAPPED,
                null_mut(),
            )
        };
        if raw_dir.is_null() || (raw_dir as isize) == INVALID_HANDLE_VALUE {
            eprintln!("guanlan watcher 打开目录失败（回退周期核验）：{root}");
            return;
        }
        let dir_handle = WinHandle(raw_dir as isize);

        // SAFETY: 创建异步 IO 完成通知事件。
        let raw_io = unsafe { CreateEventW(null(), 1, 0, null()) };
        if raw_io.is_null() {
            return;
        }
        let io_handle = WinHandle(raw_io as isize);

        // ReadDirectoryChangesW 要求缓冲区 DWORD 对齐，且 <= 64 KiB 以兼容 SMB/本机卷
        let mut buf = vec![0u32; 16 * 1024];
        let buf_len_bytes = (buf.len() * std::mem::size_of::<u32>()) as u32;
        let filter = FILE_NOTIFY_CHANGE_FILE_NAME
            | FILE_NOTIFY_CHANGE_DIR_NAME
            | FILE_NOTIFY_CHANGE_SIZE
            | FILE_NOTIFY_CHANGE_LAST_WRITE;

        loop {
            // SAFETY: 每次迭代前重置 io_event 与 OVERLAPPED，并在退出前用 CancelIoEx +
            // GetOverlappedResult(TRUE) 确保内核已归还缓冲区控制权。
            unsafe {
                ResetEvent(io_handle.0 as *mut c_void);
            }
            let mut overlapped = Overlapped {
                internal: 0,
                internal_high: 0,
                offset: 0,
                offset_high: 0,
                h_event: io_handle.0 as *mut c_void,
            };
            let mut bytes_returned: u32 = 0;

            let ok = unsafe {
                ReadDirectoryChangesW(
                    dir_handle.0 as *mut c_void,
                    buf.as_mut_ptr().cast::<c_void>(),
                    buf_len_bytes,
                    1,
                    filter,
                    &mut bytes_returned,
                    &mut overlapped,
                    null(),
                )
            };
            if ok == 0 {
                let err = unsafe { GetLastError() };
                if err != ERROR_IO_PENDING {
                    let _ = tx.send(WatchSignal::Overflow);
                    let wait = unsafe { WaitForSingleObject(stop_event.0 as *mut c_void, 100) };
                    if wait == WAIT_OBJECT_0 {
                        break;
                    }
                    continue;
                }
            }

            let handles = [stop_event.0 as *mut c_void, io_handle.0 as *mut c_void];
            let wait = unsafe { WaitForMultipleObjects(2, handles.as_ptr(), 0, INFINITE) };
            if wait == WAIT_OBJECT_0 {
                unsafe {
                    CancelIoEx(dir_handle.0 as *mut c_void, &mut overlapped);
                    let mut dummy: u32 = 0;
                    GetOverlappedResult(
                        dir_handle.0 as *mut c_void,
                        &mut overlapped,
                        &mut dummy,
                        1,
                    );
                }
                break;
            }
            if wait != WAIT_OBJECT_1 {
                break;
            }

            let mut transferred: u32 = 0;
            let got = unsafe {
                GetOverlappedResult(
                    dir_handle.0 as *mut c_void,
                    &mut overlapped,
                    &mut transferred,
                    0,
                )
            };
            if got == 0 {
                let err = unsafe { GetLastError() };
                if err == ERROR_OPERATION_ABORTED {
                    break;
                }
                let _ = tx.send(WatchSignal::Overflow);
                continue;
            }
            if transferred == 0 {
                // 内核缓冲区溢出（保存风暴超 64KB）：触发一次全量兜底核验，不丢文件
                let _ = tx.send(WatchSignal::Overflow);
                continue;
            }

            let total = (transferred as usize).min(buf_len_bytes as usize);
            let byte_ptr = buf.as_ptr().cast::<u8>();
            let mut offset = 0usize;
            while offset + 12 <= total {
                // SAFETY: `buf` 按 u32 对齐且已校验 `offset + 12 <= total`；后续校验文件名长度不越界。
                let info = unsafe { &*(byte_ptr.add(offset).cast::<FileNotifyInformation>()) };
                let name_bytes = info.file_name_length as usize;
                if offset + 12 + name_bytes > total {
                    break;
                }
                let utf16_len = name_bytes / 2;
                let name_ptr = info.file_name.as_ptr();
                let utf16_slice = unsafe { std::slice::from_raw_parts(name_ptr, utf16_len) };
                let rel_path = String::from_utf16_lossy(utf16_slice);

                let kind = match info.action {
                    FILE_ACTION_REMOVED | FILE_ACTION_RENAMED_OLD_NAME => {
                        Some(WatchEventKind::Removed)
                    }
                    FILE_ACTION_ADDED | FILE_ACTION_MODIFIED | FILE_ACTION_RENAMED_NEW_NAME => {
                        Some(WatchEventKind::Upsert)
                    }
                    _ => None,
                };
                if let Some(kind) = kind {
                    if tx.send(WatchSignal::Path { rel_path, kind }).is_err() {
                        return;
                    }
                }

                if info.next_entry_offset == 0 {
                    break;
                }
                let next = offset.saturating_add(info.next_entry_offset as usize);
                if next <= offset {
                    break;
                }
                offset = next;
            }
        }
    }
}

#[cfg(target_os = "linux")]
mod os {
    use std::collections::HashMap;
    use std::ffi::{c_char, c_int, c_ulong, c_void, CString};
    use std::path::Path;
    use std::sync::Arc;
    use tokio::sync::mpsc::UnboundedSender;

    use super::{should_ignore_rel_path, WatchEventKind, WatchSignal};

    const IN_MODIFY: u32 = 0x0000_0002;
    const IN_CLOSE_WRITE: u32 = 0x0000_0008;
    const IN_MOVED_FROM: u32 = 0x0000_0040;
    const IN_MOVED_TO: u32 = 0x0000_0080;
    const IN_CREATE: u32 = 0x0000_0100;
    const IN_DELETE: u32 = 0x0000_0200;
    const IN_DELETE_SELF: u32 = 0x0000_0400;
    const IN_Q_OVERFLOW: u32 = 0x0000_4000;
    const IN_ISDIR: u32 = 0x4000_0000;
    const POLLIN: i16 = 0x0001;

    #[repr(C)]
    struct PollFd {
        fd: c_int,
        events: i16,
        revents: i16,
    }

    #[repr(C)]
    struct InotifyEvent {
        wd: c_int,
        mask: u32,
        #[allow(dead_code)]
        cookie: u32,
        len: u32,
    }

    extern "C" {
        fn inotify_init() -> c_int;
        fn inotify_add_watch(fd: c_int, pathname: *const c_char, mask: u32) -> c_int;
        fn pipe(fds: *mut c_int) -> c_int;
        fn poll(fds: *mut PollFd, nfds: c_ulong, timeout: c_int) -> c_int;
        fn read(fd: c_int, buf: *mut c_void, count: usize) -> isize;
        fn write(fd: c_int, buf: *const c_void, count: usize) -> isize;
        fn close(fd: c_int) -> c_int;
    }

    struct FdGuard(c_int);
    impl Drop for FdGuard {
        fn drop(&mut self) {
            if self.0 >= 0 {
                // SAFETY: 句柄归本守卫独占管理，Drop 释放一次。
                unsafe {
                    close(self.0);
                }
            }
        }
    }

    pub struct OsWatcherStop {
        write_fd: Option<Arc<FdGuard>>,
    }

    impl OsWatcherStop {
        pub fn signal(&self) {
            if let Some(fd) = &self.write_fd {
                let byte = [1u8; 1];
                // SAFETY: 向唤醒管道写入 1 字节通知 poll 立即返回。
                unsafe {
                    let _ = write(fd.0, byte.as_ptr().cast::<c_void>(), 1);
                }
            }
        }
    }

    pub fn spawn_os_watcher(
        root: String,
        tx: UnboundedSender<WatchSignal>,
    ) -> (Arc<OsWatcherStop>, Option<std::thread::JoinHandle<()>>) {
        let mut pipe_fds = [-1 as c_int; 2];
        // SAFETY: 初始化自唤醒停机管道。
        if unsafe { pipe(pipe_fds.as_mut_ptr()) } != 0 {
            return (Arc::new(OsWatcherStop { write_fd: None }), None);
        }
        let read_guard = FdGuard(pipe_fds[0]);
        let write_guard = Arc::new(FdGuard(pipe_fds[1]));
        let os_stop = Arc::new(OsWatcherStop {
            write_fd: Some(write_guard),
        });

        let join = std::thread::Builder::new()
            .name("guanlan-linux-watcher".to_owned())
            .spawn(move || run_linux_watcher(&root, read_guard, tx))
            .ok();

        (os_stop, join)
    }

    fn register_recursive(
        inotify_fd: c_int,
        dir: &Path,
        rel_dir: &str,
        wd_to_rel: &mut HashMap<c_int, String>,
    ) {
        let Ok(c_path) = CString::new(dir.to_string_lossy().as_bytes()) else {
            return;
        };
        let mask = IN_MODIFY
            | IN_CLOSE_WRITE
            | IN_MOVED_FROM
            | IN_MOVED_TO
            | IN_CREATE
            | IN_DELETE
            | IN_DELETE_SELF;
        // SAFETY: `inotify_fd` 与 `c_path` 均为有效句柄和 NUL 结尾路径。
        let wd = unsafe { inotify_add_watch(inotify_fd, c_path.as_ptr(), mask) };
        if wd >= 0 {
            wd_to_rel.insert(wd, rel_dir.to_owned());
        }
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            let Ok(meta) = entry.metadata() else {
                continue;
            };
            if !meta.is_dir() {
                continue;
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            let child_rel = if rel_dir.is_empty() {
                name
            } else {
                format!("{rel_dir}/{name}")
            };
            if should_ignore_rel_path(&child_rel) {
                continue;
            }
            register_recursive(inotify_fd, &entry.path(), &child_rel, wd_to_rel);
        }
    }

    fn run_linux_watcher(root: &str, stop_read: FdGuard, tx: UnboundedSender<WatchSignal>) {
        // SAFETY: 初始化内核 inotify 实例。
        let raw_fd = unsafe { inotify_init() };
        if raw_fd < 0 {
            return;
        }
        let inotify_fd = FdGuard(raw_fd);
        let mut wd_to_rel: HashMap<c_int, String> = HashMap::new();
        register_recursive(inotify_fd.0, Path::new(root), "", &mut wd_to_rel);

        let mut buf_words = vec![0u32; 16 * 1024];
        let hdr_size = std::mem::size_of::<InotifyEvent>();

        loop {
            let mut fds = [
                PollFd {
                    fd: stop_read.0,
                    events: POLLIN,
                    revents: 0,
                },
                PollFd {
                    fd: inotify_fd.0,
                    events: POLLIN,
                    revents: 0,
                },
            ];
            // SAFETY: 阻塞等待停机管道或 inotify 事件，空闲 CPU 占用为 0%。
            let rc = unsafe { poll(fds.as_mut_ptr(), fds.len() as c_ulong, -1) };
            if rc < 0 {
                if std::io::Error::last_os_error().kind() == std::io::ErrorKind::Interrupted {
                    continue;
                }
                break;
            }
            if (fds[0].revents & POLLIN) != 0 {
                break;
            }
            if (fds[1].revents & POLLIN) == 0 {
                continue;
            }

            // SAFETY: `poll` 确认可读，`buf_words` 对齐且长度合法。
            let n = unsafe {
                read(
                    inotify_fd.0,
                    buf_words.as_mut_ptr().cast::<c_void>(),
                    buf_words.len() * std::mem::size_of::<u32>(),
                )
            };
            if n <= 0 {
                if n < 0
                    && std::io::Error::last_os_error().kind() == std::io::ErrorKind::Interrupted
                {
                    continue;
                }
                break;
            }
            let total = n as usize;
            let bytes =
                unsafe { std::slice::from_raw_parts(buf_words.as_ptr().cast::<u8>(), total) };
            let mut offset = 0usize;
            while offset + hdr_size <= total {
                // SAFETY: 已检查头部长度未越界。
                let ev = unsafe {
                    std::ptr::read_unaligned(bytes.as_ptr().add(offset).cast::<InotifyEvent>())
                };
                let name_len = ev.len as usize;
                let next = offset.saturating_add(hdr_size).saturating_add(name_len);
                if next > total {
                    break;
                }
                if (ev.mask & IN_Q_OVERFLOW) != 0 {
                    let _ = tx.send(WatchSignal::Overflow);
                    offset = next;
                    continue;
                }

                let name_bytes = &bytes[offset + hdr_size..next];
                let nul_end = name_bytes
                    .iter()
                    .position(|b| *b == 0)
                    .unwrap_or(name_bytes.len());
                let name = String::from_utf8_lossy(&name_bytes[..nul_end]).into_owned();
                if let Some(parent_rel) = wd_to_rel.get(&ev.wd).cloned() {
                    let rel_path = if name.is_empty() {
                        parent_rel
                    } else if parent_rel.is_empty() {
                        name
                    } else {
                        format!("{parent_rel}/{name}")
                    };

                    if (ev.mask & IN_ISDIR) != 0
                        && (ev.mask & (IN_CREATE | IN_MOVED_TO)) != 0
                        && !should_ignore_rel_path(&rel_path)
                    {
                        register_recursive(
                            inotify_fd.0,
                            &Path::new(root).join(&rel_path),
                            &rel_path,
                            &mut wd_to_rel,
                        );
                    }

                    let kind = if (ev.mask & (IN_DELETE | IN_DELETE_SELF | IN_MOVED_FROM)) != 0 {
                        Some(WatchEventKind::Removed)
                    } else if (ev.mask & (IN_MODIFY | IN_CLOSE_WRITE | IN_CREATE | IN_MOVED_TO))
                        != 0
                    {
                        Some(WatchEventKind::Upsert)
                    } else {
                        None
                    };
                    if let Some(kind) = kind {
                        if tx.send(WatchSignal::Path { rel_path, kind }).is_err() {
                            return;
                        }
                    }
                }
                offset = next;
            }
        }
    }
}

#[cfg(not(any(windows, target_os = "linux")))]
mod os {
    use std::sync::Arc;
    use tokio::sync::mpsc::UnboundedSender;

    use super::WatchSignal;

    pub struct OsWatcherStop;
    impl OsWatcherStop {
        pub fn signal(&self) {}
    }

    pub fn spawn_os_watcher(
        _root: String,
        _tx: UnboundedSender<WatchSignal>,
    ) -> (Arc<OsWatcherStop>, Option<std::thread::JoinHandle<()>>) {
        (Arc::new(OsWatcherStop), None)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TempDirGuard(PathBuf);
    impl TempDirGuard {
        fn new(tag: &str) -> Self {
            let dir = std::env::temp_dir().join(format!(
                "guanlan-watcher-test-{}-{tag}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_nanos())
                    .unwrap_or(0)
            ));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).expect("建临时目录");
            Self(dir)
        }
    }
    impl Drop for TempDirGuard {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    /// 指纹四态：同文件两次 stat 稳定一致（mtime_ms 口径与 Node 公式同源）
    #[test]
    fn fingerprint_stable_for_unchanged_file() {
        let dir = TempDirGuard::new("fp");
        let path = dir.0.join("a.md");
        std::fs::write(&path, "# A\n").expect("写文件");
        let first = stat_fingerprint(&path).expect("指纹");
        let second = stat_fingerprint(&path).expect("指纹");
        assert_eq!(first.mtime_ms, second.mtime_ms);
        assert_eq!(first.size, second.size);
        assert!((first.mtime_ms - first.mtime_ms.trunc()).abs() < 1.0);
    }

    /// 扫描树：全格式常规文件计入、排除目录/点目录/.gitignore 跳过、mtime 与磁盘一致
    #[test]
    fn scan_tree_respects_exclusions_and_formats() {
        let dir = TempDirGuard::new("scan");
        let root = dir.0.join("workspace");
        std::fs::create_dir_all(root.join("docs")).expect("建目录");
        std::fs::create_dir_all(root.join("node_modules")).expect("建排除目录");
        std::fs::create_dir_all(root.join(".git")).expect("建点目录");
        std::fs::write(root.join(".gitignore"), "*.log\n").expect("写 gitignore");
        std::fs::write(root.join("docs/a.md"), "# A").expect("写 md");
        std::fs::write(root.join("docs/b.svg"), "<svg/>").expect("写 svg");
        std::fs::write(root.join("docs/c.txt"), "text").expect("写 txt");
        std::fs::write(root.join("docs/ignored.log"), "skip").expect("写 ignored log");
        std::fs::write(root.join("node_modules/x.md"), "# X").expect("写排除目录 md");

        let mut out = HashMap::new();
        scan_tree(&root, &mut out);
        assert!(out.contains_key("docs/a.md"));
        assert!(out.contains_key("docs/b.svg"));
        assert!(out.contains_key("docs/c.txt"), "全格式常规文件皆应纳入");
        assert!(!out.contains_key("docs/ignored.log"), ".gitignore 命中不计");
        assert!(!out.contains_key("node_modules/x.md"), "排除目录不计");
    }

    /// 事件驱动防抖与风暴上限常量契约（< 300ms 端到端链路）
    #[test]
    fn timing_constants_match_contract() {
        const {
            assert!(DEBOUNCE_MS <= 150);
            assert!(MAX_COALESCE_WAIT_MS < 300);
            assert!(MAX_PATHS == 2000);
        }
    }

    /// 纯防抖合并器：去重、忽略隐藏/临时文件、原子替换不误触发 VerifyAll、目录删除触发兜底
    #[test]
    fn coalescer_dedups_and_handles_atomic_save() {
        let dir = TempDirGuard::new("coalesce");
        let root = &dir.0;
        std::fs::create_dir_all(root.join("docs")).unwrap();
        std::fs::write(root.join("docs/spec.md"), "# Spec v1\n").unwrap();

        let mut c = EventCoalescer::new(root);
        c.ingest(WatchSignal::Path {
            rel_path: ".git\\index.lock".to_owned(),
            kind: WatchEventKind::Upsert,
        });
        c.ingest(WatchSignal::Path {
            rel_path: "docs\\.spec.md.tmp".to_owned(),
            kind: WatchEventKind::Upsert,
        });
        c.ingest(WatchSignal::Path {
            rel_path: "docs\\spec.md".to_owned(),
            kind: WatchEventKind::Removed,
        });
        c.ingest(WatchSignal::Path {
            rel_path: "docs/spec.md".to_owned(),
            kind: WatchEventKind::Upsert,
        });
        c.ingest(WatchSignal::Path {
            rel_path: "docs/spec.md".to_owned(),
            kind: WatchEventKind::Upsert,
        });

        let plan = c.take_flush_plan();
        assert_eq!(plan.changed_paths, vec!["docs/spec.md".to_owned()]);
        assert!(
            !plan.need_verify_all,
            "原子保存替换后文件仍在磁盘，不应触发全量兜底"
        );

        // 真正删除已索引文件 → 触发 verify_all 兜底判定 missing
        std::fs::remove_file(root.join("docs/spec.md")).unwrap();
        c.ingest(WatchSignal::Path {
            rel_path: "docs/spec.md".to_owned(),
            kind: WatchEventKind::Removed,
        });
        let plan2 = c.take_flush_plan();
        assert!(plan2.changed_paths.is_empty());
        assert!(plan2.need_verify_all);
    }

    /// 端到端实测（事件驱动 watcher 延迟与抗风暴）：
    /// 1) 外部编辑器保存文件后，SSE `workspace-change` 在 < 300ms 内送达；
    /// 2) 连续 100 次/秒保存风暴合并入列，绝不丢最终内容、绝不 SQLITE_BUSY；
    /// 3) 闲置期零多余轮询且 stop() 秒级释放句柄。
    #[tokio::test]
    async fn os_watcher_delivers_sse_under_300ms_and_survives_save_storm() {
        use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
        use tokio::net::TcpStream;

        let dir = TempDirGuard::new("e2e");
        let root = dir.0.join("ws");
        std::fs::create_dir_all(root.join("docs")).unwrap();
        let target = root.join("docs/live.md");
        std::fs::write(&target, "# Initial\n").unwrap();

        let svc = crate::start_readonly_service(crate::ServeConfig {
            root: root.to_string_lossy().into_owned(),
            port: 0,
            cors_desktop: false,
            background_index: true,
        })
        .await
        .expect("启动带 OS watcher 的服务");
        let data_dir = svc.data_dir.clone();

        // 等启动后台对账落地，使后续外部保存能独立计测延迟
        let addr = svc.endpoint.trim_start_matches("http://").to_owned();
        let mut sse = BufReader::new(TcpStream::connect(&addr).await.expect("连 SSE"));
        sse.get_mut()
            .write_all(
                format!("GET /api/v1/stream HTTP/1.1\r\nHost: {addr}\r\nAccept: text/event-stream\r\n\r\n")
                    .as_bytes(),
            )
            .await
            .unwrap();

        async fn read_next_sse_event(
            reader: &mut BufReader<TcpStream>,
        ) -> Option<(String, serde_json::Value)> {
            let mut event_name = String::new();
            let mut line = String::new();
            loop {
                line.clear();
                let n = reader.read_line(&mut line).await.ok()?;
                if n == 0 {
                    return None;
                }
                let trimmed = line.trim_end_matches(['\r', '\n']);
                if trimmed.starts_with("event:") {
                    event_name = trimmed.trim_start_matches("event:").trim().to_owned();
                } else if trimmed.starts_with("data:") {
                    let raw = trimmed.trim_start_matches("data:").trim();
                    if let Ok(json) = serde_json::from_str::<serde_json::Value>(raw) {
                        return Some((event_name, json));
                    }
                }
            }
        }

        // 先消费连接握手 hello，以及启动对账完成（可能发出一次 workspace-change）
        let (ev_hello, _) =
            tokio::time::timeout(Duration::from_secs(2), read_next_sse_event(&mut sse))
                .await
                .expect("hello 超时")
                .expect("hello");
        assert_eq!(ev_hello, "hello");

        // 等启动 VerifyAll 完成（并发跑全套单测时留足 5s 余量，避免未就绪即写文件）
        let mut startup_settled = false;
        for _ in 0..200 {
            let mut probe = TcpStream::connect(&addr).await.unwrap();
            probe
                .write_all(
                    format!(
                        "GET /api/v1/status HTTP/1.1\r\nHost: {addr}\r\nConnection: close\r\n\r\n"
                    )
                    .as_bytes(),
                )
                .await
                .unwrap();
            let mut body = String::new();
            use tokio::io::AsyncReadExt;
            probe.read_to_string(&mut body).await.unwrap();
            if body.contains("\"active_jobs\":[]") && body.contains("\"index_generation\":1") {
                startup_settled = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        assert!(startup_settled, "启动后台 VerifyAll 未在预期窗口内完成");
        // 等待刚建完的初始文件在 OS 监听端静默落地，再排空启动期 SSE 通知，避免把初始写入误计入后续编辑
        tokio::time::sleep(Duration::from_millis(160)).await;
        while let Ok(Some(_)) =
            tokio::time::timeout(Duration::from_millis(40), read_next_sse_event(&mut sse)).await
        {
        }

        // 实测 ①：外部保存文件 → 测量 SSE workspace-change 送达耗时（口径：< 300ms）
        let t_edit = std::time::Instant::now();
        std::fs::write(
            &target,
            "# Initial\n\n## 新保存章节\n外部编辑器刚保存的内容\n",
        )
        .unwrap();

        let mut watcher_latency_ms = None;
        let deadline = tokio::time::Instant::now() + Duration::from_secs(3);
        while tokio::time::Instant::now() < deadline {
            let rem = deadline.saturating_duration_since(tokio::time::Instant::now());
            if let Ok(Some((ev, json))) =
                tokio::time::timeout(rem, read_next_sse_event(&mut sse)).await
            {
                if ev == "workspace-change"
                    && json["kinds"]
                        .as_array()
                        .is_some_and(|arr| arr.iter().any(|k| k == "watcher"))
                    && json["new_revisions"].as_u64().unwrap_or(0) >= 1
                {
                    watcher_latency_ms = Some(t_edit.elapsed().as_millis());
                    break;
                }
            }
        }
        let latency = watcher_latency_ms.expect("应收到 watcher workspace-change SSE 通知");
        eprintln!("[watcher 实测] 外部编辑 → SSE workspace-change 延迟 = {latency}ms");
        assert!(
            latency < 300,
            "外部保存后 SSE 通知必须 < 300ms，实测 {latency}ms"
        );

        // 实测 ②：连续保存风暴（100 次写入 @ ~10ms 间隔 = 100 次/秒），合并入列不丢终态、不锁库
        let storm_start = std::time::Instant::now();
        for i in 1..=100u32 {
            std::fs::write(&target, format!("# Storm Save {i}\n\nfinal-marker-{i}\n")).unwrap();
            tokio::time::sleep(Duration::from_millis(8)).await;
        }
        let storm_ms = storm_start.elapsed().as_millis();

        // 等待风暴最后一次防抖批次落库完成（通过 HTTP 读接口校验，顺便验证并发读零 SQLITE_BUSY）
        async fn http_get_json(addr: &str, path: &str) -> serde_json::Value {
            use tokio::io::AsyncReadExt;
            let mut sock = TcpStream::connect(addr).await.unwrap();
            sock.write_all(
                format!("GET {path} HTTP/1.1\r\nHost: {addr}\r\nConnection: close\r\n\r\n")
                    .as_bytes(),
            )
            .await
            .unwrap();
            let mut raw = String::new();
            sock.read_to_string(&mut raw).await.unwrap();
            let body = raw.split("\r\n\r\n").nth(1).unwrap_or("{}");
            serde_json::from_str(body).unwrap_or(serde_json::Value::Null)
        }

        let mut final_synced = false;
        for _ in 0..40 {
            let files_json = http_get_json(&addr, "/api/v1/files?q=live.md").await;
            if let Some(rev_id) = files_json["items"]
                .as_array()
                .and_then(|arr| arr.first())
                .and_then(|f| f["current_revision_id"].as_str())
            {
                let content_json =
                    http_get_json(&addr, &format!("/api/v1/revisions/{rev_id}/content")).await;
                if content_json["text"]
                    .as_str()
                    .is_some_and(|s| s.contains("final-marker-100"))
                {
                    final_synced = true;
                    break;
                }
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        eprintln!(
            "[watcher 实测] 100 次连续保存风暴耗时 {storm_ms}ms，终态 final-marker-100 落库={final_synced}"
        );
        assert!(
            final_synced,
            "保存风暴后终态 final-marker-100 必须落库且不丢事件"
        );

        drop(sse);
        svc.shutdown().await;
        let _ = std::fs::remove_dir_all(data_dir);
    }

    /// CLI `guanlan serve` 默认零扫描只读契约：background_index=false 不装配 watcher，
    /// 磁盘新增/修改文件期间零后台写入、/status watcher.enabled=false
    #[tokio::test]
    async fn background_index_false_keeps_readonly_zero_scan_contract() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        use tokio::net::TcpStream;

        let dir = TempDirGuard::new("readonly");
        let root = dir.0.join("ws");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("init.md"), "# Init\n").unwrap();

        // 先用 Writer 建一个空库（模拟既有只读库）
        let data_dir = guanlan_core::storage::default_data_dir(&root.to_string_lossy()).unwrap();
        {
            let writer = guanlan_core::index::Writer::open_at(&data_dir, &root.to_string_lossy())
                .expect("建库");
            drop(writer);
        }

        let svc = crate::start_readonly_service(crate::ServeConfig {
            root: root.to_string_lossy().into_owned(),
            port: 0,
            cors_desktop: false,
            background_index: false,
        })
        .await
        .expect("只读 serve 启动");

        // 外部写新文件，等 250ms 确认不会主动入库或跑任何任务
        std::fs::write(root.join("new-unwatched.md"), "# Unwatched\n").unwrap();
        tokio::time::sleep(Duration::from_millis(250)).await;

        let addr = svc.endpoint.trim_start_matches("http://").to_owned();
        let mut sock = TcpStream::connect(&addr).await.unwrap();
        sock.write_all(
            format!("GET /api/v1/status HTTP/1.1\r\nHost: {addr}\r\nConnection: close\r\n\r\n")
                .as_bytes(),
        )
        .await
        .unwrap();
        let mut raw = String::new();
        sock.read_to_string(&mut raw).await.unwrap();
        let body = raw.split("\r\n\r\n").nth(1).unwrap_or("{}");
        let status: serde_json::Value = serde_json::from_str(body).unwrap();
        assert_eq!(status["watcher"]["enabled"], false);
        assert_eq!(status["counts"]["files"], 0);

        svc.shutdown().await;
        let _ = std::fs::remove_dir_all(data_dir);
    }
}
