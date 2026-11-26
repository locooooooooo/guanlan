//! 身份与派生标识（契约 §2.3-§2.5、§2.8）。
//!
//! 本模块的每个函数都是既有 TS 管线的**逐字移植**：`server/reconcile.ts:76-119`
//! 与 `server/derive.ts:64-72`。任何一处偏差都会让 Rust 写入器在既有库里
//! 产生第二套身份（契约 §2.1 第 2 条明令禁止），因此改动前先看对应 TS 行。

use crate::domain::{normalize_rel_path, sha256_hex};
use crate::index::file_format::{class_of_token, FormatClass};

/// 短摘要（契约 §2.5；`reconcile.ts:913-915`）：
/// `sha256(input)` 的小写十六进制**前 12 个字符**。
///
/// 用于事件身份里的路径/状态片段：同一路径同一状态永远得到同一事件标识，
/// 重扫与重试不会重复记账。
pub fn stable_short(input: &str) -> String {
    sha256_hex(input.as_bytes())[..12].to_owned()
}

/// 可重放短键（FNV-1a 32 → base36；`derive.ts:64-72`）。
///
/// **UTF-16 码元口径**：JS 的 `input.length` 与 `charCodeAt(i)` 都按 UTF-16
/// 码元计，代理对算两个字符。Rust 必须按 `encode_utf16()` 迭代——用
/// `chars()`（码点）会让含 emoji 的路径/标题算出不同的 ID，进而与库里既有
/// 的 `statement_id` / `decision_id` / `edge_id` 分裂。
///
/// 溢出语义：JS `Math.imul` 是 int32 环绕乘；Rust 用 `wrapping_mul` 对齐
/// （位模式一致），最终 `>>> 0` 取无符号视图。
pub fn stable_key(input: &str) -> String {
    let mut hash: u32 = 2_166_136_261;
    for unit in input.encode_utf16() {
        hash ^= u32::from(unit);
        hash = hash.wrapping_mul(16_777_619);
    }
    base36(hash)
}

fn base36(mut value: u32) -> String {
    const DIGITS: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    if value == 0 {
        return "0".to_owned();
    }
    let mut out = Vec::new();
    while value > 0 {
        out.push(DIGITS[(value % 36) as usize]);
        value /= 36;
    }
    out.reverse();
    String::from_utf8(out).expect("base36 字母表均为 ASCII")
}

/// 标题（`reconcile.ts:96-99`）：文件名去掉尾部扩展名。
///
/// 只剥**一层**扩展名：`a.md.md` → `a.md`。
///
/// 扩展名全为 ASCII：尾部命中即说明切点落在字符边界上（不会切进多字节字符
/// 中间）。取尾部用 `str::get`——切点若不是边界会返回 None 而不是 panic。
pub fn title_from_path(relative_path: &str) -> String {
    let normalized = normalize_rel_path(relative_path);
    let base = normalized.rsplit('/').next().unwrap_or(relative_path);
    for ext in [".md", ".markdown", ".svg", ".pdf"] {
        if base.len() <= ext.len() {
            continue;
        }
        let Some(tail) = base.get(base.len() - ext.len()..) else {
            continue;
        };
        if tail.eq_ignore_ascii_case(ext) {
            return base[..base.len() - ext.len()].to_owned();
        }
    }
    base.to_owned()
}

/// 所在目录（`reconcile.ts:101-105`）：顶层文件返回 `"."`。
pub fn folder_from_path(relative_path: &str) -> String {
    let normalized = normalize_rel_path(relative_path);
    match normalized.rfind('/') {
        Some(idx) => normalized[..idx].to_owned(),
        None => ".".to_owned(),
    }
}

/// 角色判定（`reconcile.ts:107-119`）：按顺序短路，第一个命中即返回。
///
/// 判定同时看标题与路径（路径只看小写）。原实现是四个中文/英文关键词的正则，
/// 全部是无锚点的「包含」语义，这里直接用 `contains` 等价表达。
pub fn detect_role(relative_path: &str, title: &str, format: &str) -> &'static str {
    let path_lower = normalize_rel_path(relative_path).to_lowercase();
    let title_lower = title.to_lowercase();

    if ["决策", "回执", "待确认", "已确认"]
        .iter()
        .any(|kw| title_lower.contains(kw))
    {
        return "决策";
    }
    if ["需求单", "需求", "任务包", "任务卡"]
        .iter()
        .any(|kw| title_lower.contains(kw))
        || path_lower.contains("需求")
    {
        return "需求";
    }
    if ["方案", "计划书"].iter().any(|kw| title_lower.contains(kw)) || path_lower.contains("方案")
    {
        return "方案";
    }
    if ["说明", "边界", "规范"]
        .iter()
        .any(|kw| title_lower.contains(kw))
    {
        return "说明";
    }
    if ["报告", "汇报", "总览", "进度"]
        .iter()
        .any(|kw| title_lower.contains(kw))
    {
        return "报告";
    }
    if ["交接", "派发", "handoff"]
        .iter()
        .any(|kw| title_lower.contains(kw))
    {
        return "交接";
    }
    match format {
        "svg" => "素材",
        "pdf" => "说明",
        other => match class_of_token(other) {
            FormatClass::Image | FormatClass::Vector => "素材",
            _ => "其他",
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stable_short_is_sha256_prefix() {
        assert_eq!(stable_short("a/b.md"), "5a05f1b231ec");
    }

    #[test]
    fn stable_key_uses_utf16_code_units() {
        let emoji = stable_key("😀");
        let manual = {
            let mut h: u32 = 2_166_136_261;
            for unit in [0xD83Du32, 0xDE00u32] {
                h ^= unit;
                h = h.wrapping_mul(16_777_619);
            }
            base36(h)
        };
        assert_eq!(emoji, manual);
        let mut by_char: u32 = 2_166_136_261;
        for ch in "😀".chars() {
            by_char ^= ch as u32;
            by_char = by_char.wrapping_mul(16_777_619);
        }
        assert_ne!(emoji, base36(by_char));
    }

    #[test]
    fn base36_shape() {
        assert_eq!(base36(0), "0");
        assert_eq!(base36(35), "z");
        assert_eq!(base36(36), "10");
        assert_eq!(base36(u32::MAX), "1z141z3");
    }

    #[test]
    fn title_folder_and_role() {
        assert_eq!(title_from_path("docs/方案.md"), "方案");
        assert_eq!(title_from_path("docs/a.md.md"), "a.md");
        assert_eq!(title_from_path("readme.markdown"), "readme");
        assert_eq!(title_from_path("top.MD"), "top");
        assert_eq!(folder_from_path("docs/sub/a.md"), "docs/sub");
        assert_eq!(folder_from_path("top.md"), ".");

        assert_eq!(detect_role("a/决策回执.md", "决策回执", "md"), "决策");
        assert_eq!(detect_role("a/需求单.md", "需求单", "md"), "需求");
        assert_eq!(detect_role("a/计划书.md", "计划书", "md"), "方案");
        assert_eq!(detect_role("a/x.md", "x", "svg"), "素材");
        assert_eq!(detect_role("a/x.md", "x", "pdf"), "说明");
        assert_eq!(detect_role("a/x.md", "x", "md"), "其他");
        assert_eq!(detect_role("需求/x.md", "x", "md"), "需求");
    }
}
