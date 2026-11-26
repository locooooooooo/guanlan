//! 有界查询执行通道：隔离读连接、限制并发与排队并传递取消信号。
//!
//! 此前全部处理器共享 `Arc<Mutex<ReadonlyStore>>`：慢查询持锁期间轻量请求全部
//! 排队，队列无上限、无 deadline、无饱和反馈；错误包络的 generation 还在
//! Tokio 异步线程同步抢同一把锁。
//!
//! 本模块的执行形态：
//! - **连接池**：N 条独立只读连接（各自认领工作区行），轻量读取不等待其他请求
//!   的全量计算或文件读取；
//! - **有界准入**：许可数 = 连接数；排队长度与排队 deadline 双上限，饱和时确定性
//!   返回 [`GuanlanError::IndexBusy`]（503 + Retry-After，可重试，契约 §0.2）；
//! - **取消传递**：响应 future 被丢弃（客户端断开/切换）时经 CancelGuard 置位
//!   cancelled 并调用 `InterruptHandle::interrupt()` 打断进行中的 SQL；查询内
//!   由 progress handler 定期检查 cancelled 与执行 deadline；
//! - **归池清理**：查询结束先移除 progress handler、消费挂起的 interrupt 标志，
//!   再归还连接，避免旧请求的取消误伤复用连接的新请求；
//! - **generation 缓存**：阻塞任务内先轻量刷新（单行 SELECT）缓存 index_generation，
//!   错误包络取缓存值——异步线程不再同步抢数据库锁。
//!
//! 容量回收纪律：查询结束（含失败/取消）总是先归还连接再释放许可。查询体的 panic
//! 由 `catch_unwind` 接住：连接被丢弃、重建并重新认领工作区后再入池，
//! 不再随任务消失。剩下的唯一泄漏路径是任务级的 JoinError（`catch_unwind` 之外的
//! 极端情形，如 OOM）：连接随任务消失，池缩容，不做连接重建。

use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use guanlan_core::error::GuanlanError;
use guanlan_core::storage::ReadonlyStore;
use tokio::sync::Semaphore;

/// 执行通道配置（env 可调，测试用 `with_config` 显式给定）
#[derive(Clone, Copy, Debug)]
pub struct QueryConfig {
    /// 排队等待 deadline：许可内等待超过即按饱和拒绝（INDEX_BUSY）
    pub wait_deadline: Duration,
    /// 单次查询执行 deadline：progress handler 检查超限即打断长语句
    pub exec_deadline: Duration,
    /// 排队长度上限：满员后新请求立即确定性拒绝（不做无限队列）
    pub max_waiters: usize,
}

impl QueryConfig {
    /// env 口径：GUANLAN_QUERY_WAIT_MS / GUANLAN_QUERY_EXEC_MS / GUANLAN_QUERY_MAX_QUEUE，
    /// 非法或未传取默认值（wait 5s / exec 30s / queue 64）
    pub fn from_env() -> Self {
        Self {
            wait_deadline: Duration::from_millis(env_usize("GUANLAN_QUERY_WAIT_MS", 5_000) as u64),
            exec_deadline: Duration::from_millis(env_usize("GUANLAN_QUERY_EXEC_MS", 30_000) as u64),
            max_waiters: env_usize("GUANLAN_QUERY_MAX_QUEUE", 64),
        }
    }
}

/// 连接数 env 口径（lib.rs 据此开池）：GUANLAN_QUERY_POOL_SIZE，默认 4
pub fn pool_size_from_env() -> usize {
    env_usize("GUANLAN_QUERY_POOL_SIZE", 4)
}

fn env_usize(name: &str, default: usize) -> usize {
    std::env::var(name)
        .ok()
        .and_then(|v| v.parse::<usize>().ok())
        .filter(|v| *v > 0)
        .unwrap_or(default)
}

/// 有界查询执行器（AppState 持有 Arc 共享）
pub struct QueryExecutor {
    pool: Arc<Mutex<Vec<ReadonlyStore>>>,
    permits: Arc<Semaphore>,
    waiters: AtomicUsize,
    config: QueryConfig,
    pool_size: usize,
    cached_generation: Arc<AtomicU64>,
    generation_valid: Arc<AtomicBool>,
}

struct CancelGuard {
    cancelled: Arc<AtomicBool>,
    completed: Arc<AtomicBool>,
    interrupt: rusqlite::InterruptHandle,
}

impl Drop for CancelGuard {
    fn drop(&mut self) {
        if !self.completed.load(Ordering::SeqCst) {
            self.cancelled.store(true, Ordering::SeqCst);
            self.interrupt.interrupt();
        }
    }
}

impl QueryExecutor {
    /// env 配置组装
    pub fn new(stores: Vec<ReadonlyStore>) -> Self {
        Self::with_config(stores, QueryConfig::from_env())
    }

    /// 显式配置组装（测试与桌面壳定制入口）
    pub fn with_config(stores: Vec<ReadonlyStore>, config: QueryConfig) -> Self {
        assert!(!stores.is_empty(), "QueryExecutor 至少需要一条只读连接");
        let pool_size = stores.len();
        let permits = Arc::new(Semaphore::new(pool_size));
        Self {
            pool: Arc::new(Mutex::new(stores)),
            permits,
            waiters: AtomicUsize::new(0),
            config,
            pool_size,
            cached_generation: Arc::new(AtomicU64::new(0)),
            generation_valid: Arc::new(AtomicBool::new(false)),
        }
    }

    /// 连接数（= 并发执行上限）
    pub fn pool_size(&self) -> usize {
        self.pool_size
    }

    /// 错误包络 index_generation 补齐用：从未刷新过时返回 None（对齐旧口径）
    pub fn cached_generation(&self) -> Option<u64> {
        if self.generation_valid.load(Ordering::SeqCst) {
            Some(self.cached_generation.load(Ordering::SeqCst))
        } else {
            None
        }
    }

    /// 有界执行统一入口：准入 → 取连接 → spawn_blocking（generation 刷新 → 取消守护
    /// 下执行 → 归池 → 释放许可）。饱和/超时统一 [`GuanlanError::IndexBusy`]。
    ///
    /// 归池与放许可都在阻塞任务内完成（先入池、后放许可）：响应 future 被丢弃
    /// （客户端断开）时，连接与容量仍由阻塞任务闭环归还，不存在「许可已放、
    /// 连接还在路上」的取空窗口；任务 panic 是唯一的连接泄漏路径。
    pub async fn run<T, F>(&self, f: F) -> Result<T, GuanlanError>
    where
        T: Send + 'static,
        F: FnOnce(&ReadonlyStore) -> Result<T, GuanlanError> + Send + 'static,
    {
        if self.waiters.fetch_add(1, Ordering::SeqCst) >= self.config.max_waiters {
            self.waiters.fetch_sub(1, Ordering::SeqCst);
            return Err(GuanlanError::IndexBusy);
        }
        let permit = match tokio::time::timeout(
            self.config.wait_deadline,
            self.permits.clone().acquire_owned(),
        )
        .await
        {
            Ok(Ok(permit)) => permit,
            _ => {
                self.waiters.fetch_sub(1, Ordering::SeqCst);
                return Err(GuanlanError::IndexBusy);
            }
        };
        self.waiters.fetch_sub(1, Ordering::SeqCst);
        let store = {
            let mut pool = self.pool.lock().unwrap_or_else(|p| p.into_inner());
            pool.pop()
        };
        let Some(mut store) = store else {
            drop(permit);
            return Err(GuanlanError::Internal(
                "查询连接池异常耗尽（此前查询任务 panic 泄漏连接）；重启服务恢复".to_owned(),
            ));
        };

        let cancelled = Arc::new(AtomicBool::new(false));
        let completed = Arc::new(AtomicBool::new(false));
        let interrupt = store.interrupt_handle();
        let exec_deadline = Instant::now() + self.config.exec_deadline;
        {
            let cancelled = cancelled.clone();
            let completed = completed.clone();
            let _ = store.install_query_cancel_guard(Box::new(move || {
                cancelled.load(Ordering::Relaxed)
                    || (!completed.load(Ordering::Relaxed) && Instant::now() >= exec_deadline)
            }));
        }
        let guard = CancelGuard {
            cancelled: cancelled.clone(),
            completed: completed.clone(),
            interrupt,
        };

        let pool = self.pool.clone();
        let cached_generation = self.cached_generation.clone();
        let generation_valid = self.generation_valid.clone();
        let joined = tokio::task::spawn_blocking(move || {
            if let Ok(ws) = store.workspace() {
                cached_generation.store(ws.index_generation, Ordering::SeqCst);
                generation_valid.store(true, Ordering::SeqCst);
            }
            let out = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| f(&store)))
                .unwrap_or_else(|_| {
                    Err(GuanlanError::Internal(
                        "查询任务 panic，连接已丢弃并重建".to_owned(),
                    ))
                });
            completed.store(true, Ordering::SeqCst);
            store.reset_query_state();

            let poisoned = guanlan_core::storage::take_txn_poisoned();
            let store = if poisoned {
                match store.reopen() {
                    Ok(fresh) => fresh,
                    Err(err) => {
                        drop(permit);
                        return Err(GuanlanError::Internal(format!(
                            "连接重建失败，已移出池：{err}"
                        )));
                    }
                }
            } else {
                store
            };
            {
                let mut pool = pool.lock().unwrap_or_else(|p| p.into_inner());
                pool.push(store);
            }
            drop(permit);
            out
        })
        .await;

        match joined {
            Ok(result) => {
                drop(guard);
                result
            }
            Err(join_err) => {
                drop(guard);
                Err(GuanlanError::Internal(format!("查询任务失败: {join_err}")))
            }
        }
    }
}
