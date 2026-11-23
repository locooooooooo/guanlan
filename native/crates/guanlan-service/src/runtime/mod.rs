//! 运行时（方案 §2：工作区锁、队列、线程、生命周期）。
//!
//! 批次一落地：
//! - [`WorkspaceLock`]：同工作区 OS 级排他锁（方案 §7，:151——「用操作系统持有的
//!   排他锁，不能只靠可能残留的 PID 文件判断占用」）。锁经 fs2 的
//!   `try_lock_exclusive` 取得（Windows = LockFileEx 独占 + 立即失败；Unix = flock），
//!   由内核在进程退出/崩溃时随句柄自动释放，锁文件残留不构成占用。
//!   第二个实例对同一数据目录抢锁失败 → `ROOT_IN_USE`（契约 §0.2，409）。
//! - [`resolve_dist_dir`]：dist 静态资源目录解析（存在才挂载，见 http 模块）。
//! - [`generate_instance_id`]：服务实例身份（方案 §6 SSE 三元组之一；契约 §1.2
//!   「批次一生成即可」）。
//!
//! 查询/索引有界队列（INDEX_BUSY，契约 §0.2）属批次二索引接入范围，届时扩展本模块。

use std::path::{Path, PathBuf};
use std::sync::Arc;

use fs2::FileExt;
use sha2::{Digest, Sha256};

use guanlan_core::error::GuanlanError;

/// 服务锁文件名（位于数据目录内：`<dataDir>/service.lock`）。
/// 锁目标是文件上的一段字节区间（OS 级锁），文件本身只承载诊断信息
/// （进程号/取得时间），**占用判定完全不依赖其内容**——即便进程崩溃留下
/// 残留文件，重启实例仍能正常取得锁。
pub(crate) const LOCK_FILE_NAME: &str = "service.lock";
/// 诊断侧车文件（Windows 排他锁会阻止另一进程读 `service.lock`，诊断信息落独立只读文件）
pub(crate) const LOCK_INFO_FILE_NAME: &str = "service.lock.info";

/// 同工作区 OS 级排他锁。持有期间（整个服务进程生命周期）其他实例
/// 对同一数据目录的 [`acquire_workspace_lock`] 立即失败。
///
/// 释放路径：显式 [`Drop::drop`] 调 `unlock`；进程任何形式退出（含 panic
/// 与被杀死）由操作系统关闭句柄释放锁——这正是「不能只靠 PID 文件」的差别。
pub struct WorkspaceLock {
    file: std::fs::File,
    #[allow(dead_code)] // 诊断与测试断言用（锁定目标可观测）
    path: PathBuf,
}

/// Debug 手工实现（File 无 Debug；只报路径不暴露句柄），供 expect_err 断言
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
        // 释放失败不掩盖业务错误：句柄关闭时内核会兜底释放
        let _ = self.file.unlock();
        if let Some(dir) = self.path.parent() {
            let _ = std::fs::remove_file(dir.join(LOCK_INFO_FILE_NAME));
        }
    }
}

/// Windows `ERROR_LOCK_VIOLATION`（33）：锁区间已被他人持有
const ERROR_LOCK_VIOLATION: i32 = 33;

/// 对数据目录取得同工作区排他锁。
///
/// 数据目录即工作区数据身份（rootKey，契约 §3.1）：同一 root 的两个实例
/// 解析到同一目录 → 同一锁文件 → 第二个实例 `ROOT_IN_USE`。锁文件是方案 §7
/// 明确要求的运行时构件（非 index.db 写入）。
///
/// 数据目录不存在时**先建目录**：批次二起写入侧会自己建库（首次运行没有
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
    // 立即失败的独占锁：拿不到说明另一实例正在占用同一工作区
    if let Err(e) = file.try_lock_exclusive() {
        let occupied = e.kind() == std::io::ErrorKind::WouldBlock
            || e.raw_os_error() == Some(ERROR_LOCK_VIOLATION);
        return Err(if occupied {
            GuanlanError::RootInUse
        } else {
            GuanlanError::Internal(format!("获取服务锁失败 {}：{e}", path.display()))
        });
    }
    // 写入诊断信息（非占用判定依据，见 LOCK_FILE_NAME 注释）
    // 锁信息入库登记（实例身份/端点/接口版本，方案 §7）属批次二——
    // 批次一不写 index.db，运行信息只落 stderr 与 stdout 端点行（见 main.rs）。
    let pid_line = format!(
        "pid={}\nacquired_at_epoch_ms={}\n",
        std::process::id(),
        now_epoch_ms()
    );
    let _ = reset_and_write(&file, &pid_line);
    let _ = std::fs::write(data_dir.join(LOCK_INFO_FILE_NAME), &pid_line);
    Ok(WorkspaceLock { file, path })
}

/// 覆写锁文件诊断内容（先置长度为 0；失败静默，诊断信息非关键路径）
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

/// dist 静态资源目录解析（方案 §7：发布时由 Rust 提供 dist）。
///
/// 解析顺序：`GUANLAN_DIST_DIR` 环境变量（显式指定）→ 可执行文件同级的
/// `dist/`。返回的目录**存在且是目录**才返回 Some；http 层据此决定是否
/// 挂载静态资源（契约要求「dist 目录存在才挂」）。开发期由 Vite 提供前端，
/// 该解析通常返回 None，静态层不参与。
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

/// 生成服务实例身份（方案 §6 SSE 三元组 `instance_id + notice_seq + index_generation`
/// 之一；契约 contract-query-api.md §1.2：批次一生成即可）。
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

/// 进程内单调计数（批次二 SSE notice_seq 的取号器占位；本批无 SSE 不参与 wire）
#[allow(dead_code)]
#[cfg(test)]
mod tests {
    use super::*;
    use guanlan_core::error::GuanlanError;

    /// 独占锁语义：同一数据目录，第二个实例立即失败并给出 ROOT_IN_USE（契约 §0.2）
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
        // 错误包络语义：wire 码与 HTTP 状态（409）逐字对齐契约 §0.2
        assert_eq!(second.code(), "ROOT_IN_USE");
        assert_eq!(second.http_status(), 409);
        let envelope = second.to_envelope(None);
        let json = serde_json::to_string(&envelope).expect("包络序列化");
        assert!(json.contains("\"ok\":false"), "包络应含 ok:false：{json}");
        assert!(
            json.contains("\"code\":\"ROOT_IN_USE\""),
            "包络应含错误码：{json}"
        );

        // 释放后（模拟首实例退出）新实例可立即取得锁——证明占用不依赖残留文件
        drop(first);
        let third = acquire_workspace_lock(&dir).expect("释放后应可重新取得锁");
        drop(third);

        std::fs::remove_dir_all(&dir).expect("清理临时目录");
    }

    /// 实例身份：同一 (root, port) 两次生成都落在 inst_ 前缀 + 16 hex 形状
    /// （纳秒时钟参与，值不必不同；形状与长度必须稳定，契约 §1.2）
    #[test]
    fn instance_id_shape_is_stable() {
        let root = Path::new("H:\\demo");
        let id = generate_instance_id(root, 8787);
        assert!(id.starts_with("inst_"), "{id}");
        assert_eq!(id.len(), "inst_".len() + 16, "{id}");
        let again = generate_instance_id(root, 8787);
        assert_eq!(again.len(), id.len());
    }

    /// dist 解析：不存在返回 None；环境变量指向存在目录时优先
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

// ===== SSE 通知中枢（冻结契约 J：hello/workspace-change/心跳）=====

/// SSE 通知中枢：写线程经 `index_jobs::SseNotice` 桥投递，本中枢广播给全部
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

/// `/api/v1/stream` 订阅者。`notice_seq` 是传输层取号器（与业务 events.seq 无关，
/// 方案 §6/契约 §6-6：通知传输序号独立于业务序号）。
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
