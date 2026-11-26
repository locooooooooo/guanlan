//! 运行时：工作区排他锁、静态资源目录解析、实例身份与 SSE 通知中枢。
//!
//! - [`WorkspaceLock`]：同工作区 OS 级排他锁（使用操作系统持有的排他锁，
//!   不依赖可能残留的 PID 文件判断占用）。锁经 fs2 的
//!   `try_lock_exclusive` 取得（Windows = LockFileEx 独占 + 立即失败；Unix = flock），
//!   由内核在进程退出/崩溃时随句柄自动释放，锁文件残留不构成占用。
//!   第二个实例对同一数据目录抢锁失败 → `ROOT_IN_USE`（契约 §0.2，409）。
//! - [`resolve_dist_dir`]：dist 静态资源目录解析（存在才挂载，见 http 模块）。
//! - [`generate_instance_id`]：服务实例身份（SSE 三元组之一；契约 §1.2）。
//!
//! 查询侧的有界队列与饱和反馈（INDEX_BUSY，契约 §0.2）在
//! [`crate::http::query_exec`]；写侧的任务队列在 [`crate::index_jobs`]。

use std::path::{Path, PathBuf};
use std::sync::Arc;

use fs2::FileExt;
use sha2::{Digest, Sha256};

use guanlan_core::error::GuanlanError;

pub(crate) const LOCK_FILE_NAME: &str = "service.lock";
pub(crate) const LOCK_INFO_FILE_NAME: &str = "service.lock.info";

/// 同工作区 OS 级排他锁。持有期间（整个服务进程生命周期）其他实例
/// 对同一数据目录的 [`acquire_workspace_lock`] 立即失败。
///
/// 释放路径：显式 [`Drop::drop`] 调 `unlock`；进程任何形式退出（含 panic
/// 与被杀死）由操作系统关闭句柄释放锁——这正是「不能只靠 PID 文件」的差别。
pub struct WorkspaceLock {
    file: std::fs::File,
    #[allow(dead_code)]
    path: PathBuf,
}

impl std::fmt::Debug for WorkspaceLock {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("WorkspaceLock")
            .field("path", &self.path)
            .finish()
    }
}

impl WorkspaceLock {
    /// 锁文件路径（诊断用）
    #[allow(dead_code)]
    pub fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for WorkspaceLock {
    fn drop(&mut self) {
        let _ = self.file.unlock();
        if let Some(dir) = self.path.parent() {
            let _ = std::fs::remove_file(dir.join(LOCK_INFO_FILE_NAME));
        }
    }
}

const ERROR_LOCK_VIOLATION: i32 = 33;

/// 对数据目录取得同工作区排他锁。
///
/// 数据目录即工作区数据身份（rootKey，契约 §3.1）：同一 root 的两个实例
/// 解析到同一目录 → 同一锁文件 → 第二个实例 `ROOT_IN_USE`。锁文件是独立的
/// 运行时构件（非 index.db 写入）。
///
/// 数据目录不存在时**先建目录**：写入侧会在首次运行时建库（首次运行没有
/// 既有 index.db），锁必须先于库存在，否则首跑会在打开锁文件时失败。
pub fn acquire_workspace_lock(data_dir: &Path) -> Result<WorkspaceLock, GuanlanError> {
    if !data_dir.is_dir() {
        std::fs::create_dir_all(data_dir).map_err(|e| {
            GuanlanError::Internal(format!("创建数据目录失败 {}：{e}", data_dir.display()))
        })?;
    }
    let path = data_dir.join(LOCK_FILE_NAME);
    let file = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(&path)
        .map_err(|e| {
            GuanlanError::Internal(format!("无法打开服务锁文件 {}：{e}", path.display()))
        })?;
    if let Err(e) = file.try_lock_exclusive() {
        let occupied = e.kind() == std::io::ErrorKind::WouldBlock
            || e.raw_os_error() == Some(ERROR_LOCK_VIOLATION);
        return Err(if occupied {
            GuanlanError::RootInUse
        } else {
            GuanlanError::Internal(format!("获取服务锁失败 {}：{e}", path.display()))
        });
    }
    let pid_line = format!(
        "pid={}\nacquired_at_epoch_ms={}\n",
        std::process::id(),
        now_epoch_ms()
    );
    let _ = reset_and_write(&file, &pid_line);
    let _ = std::fs::write(data_dir.join(LOCK_INFO_FILE_NAME), &pid_line);
    Ok(WorkspaceLock { file, path })
}

fn reset_and_write(file: &std::fs::File, content: &str) -> std::io::Result<()> {
    use std::io::{Seek, SeekFrom, Write};
    let mut f = file;
    f.set_len(0)?;
    f.seek(SeekFrom::Start(0))?;
    f.write_all(content.as_bytes())
}

fn now_epoch_ms() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

pub(crate) fn resolve_dist_dir() -> Option<PathBuf> {
    if let Ok(env_dir) = std::env::var("GUANLAN_DIST_DIR") {
        if !env_dir.is_empty() {
            let candidate = PathBuf::from(env_dir);
            return candidate.is_dir().then_some(candidate);
        }
    }
    let exe = std::env::current_exe().ok()?;
    let candidate = exe.parent()?.join("dist");
    candidate.is_dir().then_some(candidate)
}

/// 生成服务实例身份（SSE 三元组 `instance_id + notice_seq + index_generation`
/// 之一；契约 contract-query-api.md §1.2）。
/// 由进程号 + 纳秒时钟 + 端口 + 根目录派生 16 位 hex，不引入随机数依赖。
pub fn generate_instance_id(root: &Path, port: u16) -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let mut hasher = Sha256::new();
    hasher.update(std::process::id().to_le_bytes());
    hasher.update(nanos.to_le_bytes());
    hasher.update(port.to_le_bytes());
    hasher.update(root.to_string_lossy().as_bytes());
    let digest = hasher.finalize();
    format!("inst_{}", hex::encode(&digest[..8]))
}

#[allow(dead_code)]
#[cfg(test)]
mod tests {
    use super::*;
    use guanlan_core::error::GuanlanError;

    #[test]
    fn second_instance_gets_root_in_use() {
        let dir = std::env::temp_dir().join(format!(
            "guanlan-svc-lock-{}-{}",
            std::process::id(),
            now_epoch_ms()
        ));
        std::fs::create_dir_all(&dir).expect("创建临时目录");

        let first = acquire_workspace_lock(&dir).expect("首实例应取得锁");
        assert!(first.path().ends_with(LOCK_FILE_NAME));

        let second = acquire_workspace_lock(&dir).expect_err("第二实例应被拒");
        match &second {
            GuanlanError::RootInUse => {}
            other => panic!("应报 ROOT_IN_USE，实际 {other:?}"),
        }
        assert_eq!(second.code(), "ROOT_IN_USE");
        assert_eq!(second.http_status(), 409);
        let envelope = second.to_envelope(None);
        let json = serde_json::to_string(&envelope).expect("包络序列化");
        assert!(json.contains("\"ok\":false"), "包络应含 ok:false：{json}");
        assert!(
            json.contains("\"code\":\"ROOT_IN_USE\""),
            "包络应含错误码：{json}"
        );

        drop(first);
        let third = acquire_workspace_lock(&dir).expect("释放后应可重新取得锁");
        drop(third);

        std::fs::remove_dir_all(&dir).expect("清理临时目录");
    }

    #[test]
    fn instance_id_shape_is_stable() {
        let root = Path::new("H:\\demo");
        let id = generate_instance_id(root, 8787);
        assert!(id.starts_with("inst_"), "{id}");
        assert_eq!(id.len(), "inst_".len() + 16, "{id}");
        let again = generate_instance_id(root, 8787);
        assert_eq!(again.len(), id.len());
    }

    #[test]
    fn resolve_dist_dir_by_env() {
        let dir = std::env::temp_dir().join(format!(
            "guanlan-svc-dist-{}-{}",
            std::process::id(),
            now_epoch_ms()
        ));
        std::fs::create_dir_all(&dir).expect("建临时 dist 目录");
        std::env::set_var("GUANLAN_DIST_DIR", &dir);
        let resolved = resolve_dist_dir().expect("环境变量指向存在目录应解析成功");
        assert_eq!(resolved, dir);
        std::env::remove_var("GUANLAN_DIST_DIR");
        std::fs::remove_dir_all(&dir).expect("清理");
    }
}

/// 计算工作区根目录的稳定 16 位 hex 身份键（与存储层 `default_data_dir` 同源）。
pub fn workspace_root_key(root: &str) -> Result<String, GuanlanError> {
    guanlan_core::domain::resolve_root(root)
        .map(|resolved| guanlan_core::domain::root_key_of_resolved(&resolved))
}

/// 解析工作区数据目录、锁文件路径与当前锁诊断文本（供桌面壳 `ROOT_IN_USE` 恢复面板展示）。
pub fn workspace_lock_context(
    root: &str,
) -> Result<(PathBuf, PathBuf, Option<String>), GuanlanError> {
    let data_dir = guanlan_core::storage::default_data_dir(root)?;
    let lock_path = data_dir.join(LOCK_FILE_NAME);
    let diag = read_lock_diagnostics(&data_dir);
    Ok((data_dir, lock_path, diag))
}

/// 读取 `<data_dir>/service.lock.info`（回退 `service.lock`）内的诊断文本（pid/获取时间戳；失败或不存在返回 None）。
/// 只作冲突排查提示之用，不作为锁占用判定依据。
pub fn read_lock_diagnostics(data_dir: &Path) -> Option<String> {
    for candidate in [LOCK_INFO_FILE_NAME, LOCK_FILE_NAME] {
        if let Ok(text) = std::fs::read_to_string(data_dir.join(candidate)) {
            let trimmed = text.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_owned());
            }
        }
    }
    None
}

/// SSE 通知中枢：写线程经 `index_jobs::SseNotice` 桥投递，广播给全部
/// `/api/v1/stream` 订阅者。`notice_seq` 是传输层取号器（与业务 events.seq 无关，
/// 契约 contract-storage.md §6-6：通知传输序号独立于业务序号）。
#[derive(Clone)]
pub struct NoticeHub {
    sender:
        Arc<std::sync::Mutex<Option<tokio::sync::broadcast::Sender<crate::index_jobs::SseNotice>>>>,
    seq: Arc<std::sync::atomic::AtomicU64>,
}

impl NoticeHub {
    /// 容量 64：慢订阅者丢旧通知（Lagged 自恢复，SSE 语义允许），
    /// 本地回环广播不会积压太多
    pub fn new() -> Self {
        let (sender, _) = tokio::sync::broadcast::channel(64);
        Self {
            sender: Arc::new(std::sync::Mutex::new(Some(sender))),
            seq: Arc::new(std::sync::atomic::AtomicU64::new(0)),
        }
    }

    /// 订阅：返回 (订阅起始 notice_seq, 接收端)——hello 事件携带起始序号，
    /// 断线重连的客户端据此判断丢了多少通知（契约 §6-6「新连接补发最新
    /// generation，断线重连不丢通知」的 v1 口径）。
    /// 若已关闭，返回一个立即产生 `RecvError::Closed` 的接收端。
    pub fn subscribe(
        &self,
    ) -> (
        u64,
        tokio::sync::broadcast::Receiver<crate::index_jobs::SseNotice>,
    ) {
        let seq = self.next_seq();
        let rx = {
            let guard = self.sender.lock().expect("通知广播锁");
            match guard.as_ref() {
                Some(tx) => tx.subscribe(),
                None => {
                    let (_, closed_rx) = tokio::sync::broadcast::channel(1);
                    closed_rx
                }
            }
        };
        (seq, rx)
    }

    /// 传输层取号（原子递增；notice_seq 与 events.seq 无关）
    pub fn next_seq(&self) -> u64 {
        self.seq.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    }

    /// 投递通知（无订阅者或已关闭时静默）
    pub fn publish(&self, notice: crate::index_jobs::SseNotice) {
        if let Some(tx) = self.sender.lock().expect("通知广播锁").as_ref() {
            let _ = tx.send(notice);
        }
    }

    /// 关闭广播通道：让所有活跃 SSE 长连接立即收尾退出，便于服务优雅停机。
    pub fn close(&self) {
        *self.sender.lock().expect("通知广播锁") = None;
    }
}

impl Default for NoticeHub {
    fn default() -> Self {
        Self::new()
    }
}
