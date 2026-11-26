//! 响应字节预算与限长读取。
//!
//! 此前 content 路由 `tokio::fs::read` 整读快照、`from_utf8_lossy` 复制一份、
//! `Json(...).into_response()` 再同步序列化一份——单请求峰值 ≈ 3×B，K 并发 ≈ 3KB，
//! 且 256 KiB 上限只约束另一条内联路径、只信任 DB 的 `size_bytes`。
//!
//! 本模块提供三层约束：
//! 1. **限长读取**：打开后取实际 `metadata().len()`（不信 DB 值），超过单响应上限
//!    直接返回明确错误（提示 raw=1 流式），不做「先整读再判断」；
//! 2. **字节预算**：全局信号量以「字节」为许可单位；受理请求前按实际大小
//!    预占，预算不足则等待（有 deadline），超时按饱和拒绝；
//! 3. **预算随响应体释放**：许可挂在 [`BudgetedBody`] 上，随响应体被 hyper
//!    读完/丢弃才归还——覆盖「原始字节 → 文本转换 → JSON 缓冲 → 响应发送」全生命周期，
//!    不是读完文件就提前释放。
//!
//! 大正文的推荐路径是 `raw=1` 流式（分块 64KiB，恒定内存），预算只服务内联路径。

use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};
use std::time::Duration;

use axum::body::{Body, Bytes, HttpBody};
use http_body::{Frame, SizeHint};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

use guanlan_core::error::GuanlanError;

const DEFAULT_TOTAL_BYTES: usize = 64 * 1024 * 1024;
const DEFAULT_MAX_SINGLE_BYTES: usize = 8 * 1024 * 1024;
const BUDGET_WAIT: Duration = Duration::from_secs(5);

/// 响应字节预算（AppState 持有 Arc 共享）
pub struct ResponseBudget {
    permits: Arc<Semaphore>,
    capacity: usize,
    max_single: usize,
}

impl ResponseBudget {
    pub fn new(total_bytes: usize, max_single: usize) -> Self {
        let capacity = total_bytes.max(1);
        Self {
            permits: Arc::new(Semaphore::new(capacity)),
            capacity,
            max_single: max_single.max(1),
        }
    }

    /// env 配置：GUANLAN_RESPONSE_BUDGET_MIB（默认 64）、GUANLAN_RESPONSE_MAX_MIB（默认 8）
    pub fn from_env() -> Self {
        let total = env_usize(
            "GUANLAN_RESPONSE_BUDGET_MIB",
            DEFAULT_TOTAL_BYTES / (1024 * 1024),
        ) * 1024
            * 1024;
        let single = env_usize(
            "GUANLAN_RESPONSE_MAX_MIB",
            DEFAULT_MAX_SINGLE_BYTES / (1024 * 1024),
        ) * 1024
            * 1024;
        Self::new(total, single)
    }

    /// 单响应字节上限（内联 JSON 路径）
    pub fn max_single(&self) -> usize {
        self.max_single
    }

    /// 已用许可（诊断/测试用）：总容量 - 当前可用
    pub fn in_use_bytes(&self) -> usize {
        self.capacity
            .saturating_sub(self.permits.available_permits())
    }

    /// 预占 `bytes` 字节预算。超过单响应上限 → UNSUPPORTED_CONTENT（提示 raw=1）；
    /// 预算不足且等待超时 → INDEX_BUSY（可重试，与查询饱和同码）。
    pub async fn acquire(&self, bytes: usize) -> Result<BudgetedPermit, GuanlanError> {
        if bytes > self.max_single {
            return Err(GuanlanError::UnsupportedContent(format!(
                "正文 {bytes} 字节超过内联上限 {} 字节；请用 raw=1 流式读取",
                self.max_single
            )));
        }
        let want = bytes.max(1).min(self.capacity) as u32;
        match tokio::time::timeout(BUDGET_WAIT, self.permits.clone().acquire_many_owned(want)).await
        {
            Ok(Ok(permit)) => Ok(BudgetedPermit(Some(permit))),
            Ok(Err(_)) => Err(GuanlanError::Internal("响应预算执行器已关闭".to_owned())),
            Err(_) => Err(GuanlanError::IndexBusy),
        }
    }
}

fn env_usize(name: &str, default: usize) -> usize {
    std::env::var(name)
        .ok()
        .and_then(|v| v.parse::<usize>().ok())
        .filter(|v| *v > 0)
        .unwrap_or(default)
}

/// 预算许可（RAII）：持有期间占用字节额度
pub struct BudgetedPermit(Option<OwnedSemaphorePermit>);

impl BudgetedPermit {
    /// 把许可所有权移交给响应体（随响应体 drop 才归还）
    pub fn into_guard(mut self) -> BudgetGuard {
        BudgetGuard(self.0.take())
    }
}

/// 响应体持有的预算守护
pub struct BudgetGuard(Option<OwnedSemaphorePermit>);

/// 带预算守护的响应体：许可直到响应体被读完/丢弃才释放，
/// 覆盖「构造响应缓冲 → 发送」全生命周期。
pub struct BudgetedBody {
    inner: Body,
    guard: BudgetGuard,
}

impl BudgetedBody {
    pub fn new(inner: Body, guard: BudgetGuard) -> Self {
        Self { inner, guard }
    }
}

impl HttpBody for BudgetedBody {
    type Data = Bytes;
    type Error = axum::Error;

    fn poll_frame(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Self::Data>, Self::Error>>> {
        let this = self.get_mut();
        Pin::new(&mut this.inner).poll_frame(cx)
    }

    fn is_end_stream(&self) -> bool {
        self.inner.is_end_stream()
    }

    fn size_hint(&self) -> SizeHint {
        self.inner.size_hint()
    }
}

impl Drop for BudgetedBody {
    fn drop(&mut self) {
        self.guard.0.take();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn over_single_limit_rejected_with_explicit_code() {
        let budget = ResponseBudget::new(1024, 100);
        let err = budget.acquire(101).await.err().expect("应超限拒绝");
        assert_eq!(err.code(), "UNSUPPORTED_CONTENT");
        assert!(
            err.to_string().contains("raw=1"),
            "错误提示应指向流式读取：{err}"
        );
    }

    #[tokio::test]
    async fn budget_exhaustion_returns_busy_not_oom() {
        let budget = ResponseBudget::new(100, 100);
        let held = budget.acquire(100).await.expect("首笔应成功");
        let err = budget
            .acquire(50)
            .await
            .err()
            .expect("预算耗尽应等待后拒绝");
        assert_eq!(err.code(), "INDEX_BUSY", "饱和按可重试码返回");
        drop(held);
        budget.acquire(50).await.expect("释放后可再分配");
    }

    #[tokio::test]
    async fn body_guard_holds_permit_until_body_dropped() {
        let budget = ResponseBudget::new(100, 100);
        let permit = budget.acquire(100).await.expect("占用全部预算");
        let body = BudgetedBody::new(Body::from(vec![0u8; 10]), permit.into_guard());
        let contended = budget.acquire(1).await;
        assert!(contended.is_err(), "响应体未释放前预算仍被占用");
        drop(body);
        budget.acquire(100).await.expect("响应体释放后预算归还");
    }
}
