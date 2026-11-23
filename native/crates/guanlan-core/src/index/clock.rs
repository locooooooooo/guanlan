//! UTC ISO-8601 时间格式化（与 Node `Date#toISOString()` 逐字兼容）。
//!
//! 观澜写入侧产出的 `observed_at` / `last_scan_at` / `created_at` / `verified_at`
//! 必须与既有 TS 管线写入的行同形，否则同一事实会出现两种时间串。口径：
//!
//! - Node `new Date(x).toISOString()`：入参毫秒时间戳，`TimeClip` 内部按
//!   `ToInteger` **截断**小数部分；输出恒为 UTC，格式 `YYYY-MM-DDTHH:mm:ss.sssZ`
//!   （毫秒固定三位）
//!
//! 不引入 chrono：其传递依赖 `iana-time-zone` / `windows-link` 不在本机 cargo
//! 缓存内，离线解析会失败。改按 civil-from-days 算法手写换算，无外部依赖。

/// 一天的毫秒数
const MS_PER_DAY: i64 = 86_400_000;

/// 毫秒时间戳 → `YYYY-MM-DDTHH:mm:ss.sssZ`（UTC）
pub fn iso_from_epoch_millis(epoch_ms: i64) -> String {
    let (days, ms_of_day) = split_days(epoch_ms);
    let (year, month, day) = civil_from_days(days);
    let hour = ms_of_day / 3_600_000;
    let minute = (ms_of_day / 60_000) % 60;
    let second = (ms_of_day / 1_000) % 60;
    let milli = ms_of_day % 1_000;
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{milli:03}Z")
}

/// 毫秒时间戳 → `YYYY-MM-DD`（UTC 日期）
pub fn date_only_from_epoch_millis(epoch_ms: i64) -> String {
    let (days, _) = split_days(epoch_ms);
    let (year, month, day) = civil_from_days(days);
    format!("{year:04}-{month:02}-{day:02}")
}

/// 当前时刻的 ISO 串（UTC，毫秒三位）
pub fn now_iso() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    iso_from_epoch_millis(now)
}

/// 观测时刻 → 「小时戳」（契约 §2.5 的 `observedAt.slice(0,13).replace(/[:T]/g,'')`）：
/// `2026-11-17T08` → `2026111708`。
///
/// 直接按 ISO 串的前 13 字符裁剪并去掉 `:` / `T`，与 TS 逐字同源，
/// 避免两处各算一遍 UTC 时分导致跨小时错位。
pub fn hour_stamp(observed_at_iso: &str) -> String {
    observed_at_iso
        .chars()
        .take(13)
        .filter(|c| *c != ':' && *c != 'T')
        .collect()
}

/// 观测时刻 → 日期部分（`observedAt.slice(0, 10)`）
pub fn date_part(observed_at_iso: &str) -> String {
    observed_at_iso.chars().take(10).collect()
}

/// 拆分为「自 1970-01-01 起的天数」与「当日毫秒偏移」（负数时间戳向下取整）
fn split_days(epoch_ms: i64) -> (i64, i64) {
    let days = epoch_ms.div_euclid(MS_PER_DAY);
    let ms_of_day = epoch_ms.rem_euclid(MS_PER_DAY);
    (days, ms_of_day)
}

/// 天数 → 公历 (年, 月, 日)（Howard Hinnant 的 civil_from_days）
fn civil_from_days(days: i64) -> (i64, i64, i64) {
    // 把 1970-01-01 平移为 0000-03-01 起算
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 }.div_euclid(146_097);
    let doe = z - era * 146_097; // [0, 146096]
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365; // [0, 399]
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let d = doy - (153 * mp + 2) / 5 + 1; // [1, 31]
    let m = if mp < 10 { mp + 3 } else { mp - 9 }; // [1, 12]
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// 公历 (年, 月, 日) → 自 1970-01-01 起的天数（civil_from_days 的逆，
/// Howard Hinnant 的 days_from_civil；供超期归档的天数差计算用）
pub fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let y = if month <= 2 { year - 1 } else { year };
    let era = if y >= 0 { y } else { y - 399 }.div_euclid(400);
    let yoe = y - era * 400; // [0, 399]
    let mp = (month + 9) % 12; // [0, 11]，三月=0
    let doy = (153 * mp + 2) / 5 + day - 1; // [0, 365]
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy; // [0, 146096]
    era * 146_097 + doe - 719_468
}

/// ISO 串（`YYYY-MM-DD…`）→ 自 1970-01-01 起的天数；前缀不是合法日期返回 None。
/// 只取前 10 个字符（与 date_part 同口径），兼容纯日期与完整 ISO 时刻。
pub fn days_since_epoch_of_iso(iso: &str) -> Option<i64> {
    let date = iso.get(0..10)?;
    let mut parts = date.split('-');
    let year: i64 = parts.next()?.parse().ok()?;
    let month: i64 = parts.next()?.parse().ok()?;
    let day: i64 = parts.next()?.parse().ok()?;
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    Some(days_from_civil(year, month, day))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn iso_matches_node_to_iso_string() {
        // node -e "console.log(new Date(0).toISOString())" → 1970-01-01T00:00:00.000Z
        assert_eq!(iso_from_epoch_millis(0), "1970-01-01T00:00:00.000Z");
        // node -e "console.log(new Date(1767225600000).toISOString())" → 2026-01-01T00:00:00.000Z
        assert_eq!(
            iso_from_epoch_millis(1_767_225_600_000),
            "2026-01-01T00:00:00.000Z"
        );
        // 毫秒三位补齐
        assert_eq!(
            iso_from_epoch_millis(1_767_225_600_123),
            "2026-01-01T00:00:00.123Z"
        );
        // 闰年 2 月 29 日
        assert_eq!(
            iso_from_epoch_millis(1_709_164_800_000),
            "2024-02-29T00:00:00.000Z"
        );
    }

    #[test]
    fn date_only_and_hour_stamp() {
        let iso = iso_from_epoch_millis(1_767_225_600_000);
        assert_eq!(date_only_from_epoch_millis(1_767_225_600_000), "2026-01-01");
        assert_eq!(date_part(&iso), "2026-01-01");
        // TS: '2026-01-01T08'.slice(0,13).replace(/[:T]/g,'') → '2026-01-0108'
        // （只去冒号与 T，破折号保留——时刻戳因此仍可读出日期）
        assert_eq!(hour_stamp("2026-01-01T08:59:12.345Z"), "2026-01-0108");
        assert_eq!(hour_stamp("2026-11-17T08:59:12.345Z"), "2026-11-1708");
    }

    #[test]
    fn negative_epoch_floors_like_date_constructor() {
        // new Date(-1).toISOString() → 1969-12-31T23:59:59.999Z
        assert_eq!(iso_from_epoch_millis(-1), "1969-12-31T23:59:59.999Z");
    }

    #[test]
    fn days_from_civil_roundtrips_with_civil_from_days() {
        // 与 civil_from_days 互逆：1970-01-01 起逐点往返
        for days in [-719_468i64, -1, 0, 1, 19_000, 20_620] {
            let (y, m, d) = civil_from_days(days);
            assert_eq!(days_from_civil(y, m, d), days, "往返失败 {days}");
        }
        assert_eq!(days_from_civil(1970, 1, 1), 0);
        // 与既有 iso 测试锚点一致：1767225600000ms = 2026-01-01 = 第 20454 天
        assert_eq!(days_from_civil(2026, 1, 1), 20_454);
        // 闰日：往返自证（2026-01-01 = 20620 已由 iso 测试锚定）
        assert_eq!(civil_from_days(days_from_civil(2024, 2, 29)), (2024, 2, 29));
        // ISO 前缀解析（2026-01-01 = 第 20454 天）
        assert_eq!(
            days_since_epoch_of_iso("2026-01-02T03:14:15.926Z"),
            Some(20_455)
        );
        assert_eq!(days_since_epoch_of_iso("2026-01-02"), Some(20_455));
        assert_eq!(days_since_epoch_of_iso("not-a-date"), None);
        assert_eq!(days_since_epoch_of_iso("2026-13-01"), None);
    }
}
