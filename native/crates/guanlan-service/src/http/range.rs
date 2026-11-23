//! HTTP Range / 条件请求纯函数（issue #37）。
//!
//! PDF 快照已是 64KiB 分块流式（内存方向正确），但此前不接收请求头：
//! 只有 Content-Type，永远 200 全量，缺 Range / Content-Length / ETag / 条件请求——
//! 支持范围读取的阅读器在跳页/重开时可能重复拉全文件。
//!
//! 这里只放可单测的解析与判定；实际读写仍在服务层（分块流，不整读）。

/// Range 解析结果
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RangeOutcome {
    /// 无 Range / 多区间 / 语法不可解析 → 按全量 200 返回（回退行为明确）
    Full,
    /// 单区间（闭区间，含边界）
    Partial { start: u64, end: u64 },
    /// 可解析但不可满足 → 416
    Unsatisfiable,
}

/// 解析 `Range: bytes=...`（单区间 / 开放结尾 / 后缀形式）。
///
/// - `bytes=0-99` → 0..=99（end 超界按 len-1 截断）
/// - `bytes=100-` → 100..=len-1
/// - `bytes=-100` → 末 100 字节
/// - 多区间（含逗号）→ `Full`（明确回退全量，不做 multipart）
/// - 起点 ≥ len 或 len==0 → `Unsatisfiable`
pub fn parse_range(header_value: Option<&str>, len: u64) -> RangeOutcome {
    let Some(raw) = header_value else {
        return RangeOutcome::Full;
    };
    let raw = raw.trim();
    let Some(spec) = raw.strip_prefix("bytes=") else {
        return RangeOutcome::Full; // 非 bytes 单位：忽略 Range（RFC 7233 允许）
    };
    if spec.contains(',') {
        return RangeOutcome::Full; // 多区间：明确回退全量
    }
    let Some((start_s, end_s)) = spec.split_once('-') else {
        return RangeOutcome::Full;
    };
    let start_s = start_s.trim();
    let end_s = end_s.trim();

    if start_s.is_empty() {
        // 后缀形式 bytes=-N：末 N 字节
        let Ok(suffix) = end_s.parse::<u64>() else {
            return RangeOutcome::Full;
        };
        if suffix == 0 || len == 0 {
            return RangeOutcome::Unsatisfiable;
        }
        let start = len.saturating_sub(suffix);
        return RangeOutcome::Partial {
            start,
            end: len - 1,
        };
    }

    let Ok(start) = start_s.parse::<u64>() else {
        return RangeOutcome::Full;
    };
    if len == 0 || start >= len {
        return RangeOutcome::Unsatisfiable;
    }
    let end = if end_s.is_empty() {
        len - 1
    } else {
        match end_s.parse::<u64>() {
            Ok(v) if v >= start => v.min(len - 1),
            // end < start 或不可解析：按 RFC 视为不可满足
            _ => return RangeOutcome::Unsatisfiable,
        }
    };
    RangeOutcome::Partial { start, end }
}

/// 内容哈希 → 强 ETag。带引号、带 `sha256-` 前缀（与内容寻址一致，跨重启稳定）。
pub fn etag_for_content_hash(hash: &str) -> String {
    format!("\"sha256-{hash}\"")
}

/// `If-None-Match` 是否命中（命中 → 304）。
/// 支持 `*`、逗号列表、`W/` 弱前缀（弱比较语义对 GET 成立）。
pub fn if_none_match_hits(header_value: Option<&str>, etag: &str) -> bool {
    let Some(raw) = header_value else {
        return false;
    };
    let target = strip_weak(etag);
    raw.split(',').any(|item| {
        let item = item.trim();
        item == "*" || strip_weak(item) == target
    })
}

/// `If-Range` 是否仍然匹配（不匹配 → 忽略 Range，返回全量）。
/// 支持 ETag 形式；HTTP-date 形式一律视为不匹配（我们不发布 Last-Modified）。
pub fn if_range_matches(header_value: Option<&str>, etag: &str) -> bool {
    match header_value {
        None => true, // 没有 If-Range：Range 照常生效
        Some(raw) => {
            let raw = raw.trim();
            if raw.is_empty() {
                return true;
            }
            // HTTP-date（含字母星期/月份缩写或冒号）: 无 Last-Modified 可比 → 不匹配
            if raw.contains(':') || raw.contains("GMT") {
                return false;
            }
            strip_weak(raw) == strip_weak(etag)
        }
    }
}

fn strip_weak(tag: &str) -> &str {
    tag.trim().strip_prefix("W/").unwrap_or(tag.trim())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_single_open_and_suffix_ranges() {
        assert_eq!(
            parse_range(Some("bytes=0-99"), 1000),
            RangeOutcome::Partial { start: 0, end: 99 }
        );
        assert_eq!(
            parse_range(Some("bytes=100-"), 1000),
            RangeOutcome::Partial {
                start: 100,
                end: 999
            }
        );
        assert_eq!(
            parse_range(Some("bytes=-100"), 1000),
            RangeOutcome::Partial {
                start: 900,
                end: 999
            }
        );
        // end 超界按 len-1 截断
        assert_eq!(
            parse_range(Some("bytes=900-5000"), 1000),
            RangeOutcome::Partial {
                start: 900,
                end: 999
            }
        );
    }

    #[test]
    fn unsupported_or_multi_range_falls_back_to_full() {
        assert_eq!(parse_range(None, 1000), RangeOutcome::Full);
        assert_eq!(parse_range(Some("items=0-10"), 1000), RangeOutcome::Full);
        assert_eq!(
            parse_range(Some("bytes=0-10,20-30"), 1000),
            RangeOutcome::Full
        );
        assert_eq!(parse_range(Some("bytes=abc"), 1000), RangeOutcome::Full);
    }

    #[test]
    fn unsatisfiable_ranges() {
        assert_eq!(
            parse_range(Some("bytes=1000-"), 1000),
            RangeOutcome::Unsatisfiable
        );
        assert_eq!(
            parse_range(Some("bytes=2000-3000"), 1000),
            RangeOutcome::Unsatisfiable
        );
        assert_eq!(
            parse_range(Some("bytes=-0"), 1000),
            RangeOutcome::Unsatisfiable
        );
        assert_eq!(
            parse_range(Some("bytes=0-"), 0),
            RangeOutcome::Unsatisfiable
        );
        assert_eq!(
            parse_range(Some("bytes=5-1"), 1000),
            RangeOutcome::Unsatisfiable
        );
    }

    #[test]
    fn etag_and_conditional_headers() {
        let etag = etag_for_content_hash("abc123");
        assert_eq!(etag, "\"sha256-abc123\"");
        assert!(if_none_match_hits(Some(&etag), &etag));
        assert!(
            if_none_match_hits(Some(&format!("W/{etag}")), &etag),
            "弱比较成立"
        );
        assert!(
            if_none_match_hits(Some(&format!("\"other\", {etag}")), &etag),
            "列表命中"
        );
        assert!(if_none_match_hits(Some("*"), &etag));
        assert!(!if_none_match_hits(Some("\"other\""), &etag));
        assert!(!if_none_match_hits(None, &etag));

        assert!(if_range_matches(None, &etag));
        assert!(if_range_matches(Some(&etag), &etag));
        assert!(!if_range_matches(Some("\"other\""), &etag));
        assert!(
            !if_range_matches(Some("Wed, 21 Oct 2015 07:28:00 GMT"), &etag),
            "HTTP-date 不支持"
        );
    }
}
