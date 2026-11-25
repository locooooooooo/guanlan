//! 跨项目只读挂载——参考工作区路径规范化与互斥判定。
//!
//! 三条硬规则（契约 contract-storage.md §13）：
//! 1. **plain() 语义**：Windows 扩展前缀 `\\?\`（长路径）与 `\\?\UNC\` 统一剥离，
//!    规范化结果无 `\\?\` 泄漏——挂载身份哈希对「同一目录的不同写法」稳定一致；
//! 2. **父子目录互斥**：当前工作区与参考工作区（以及挂载区彼此之间）严禁互为
//!    祖先/后代目录——嵌套挂载会让相对路径语义成环，一律确定性拒绝（MOUNT_REJECTED）；
//! 3. **挂载身份命名空间独立**：`mount_key = sha256(规范化绝对路径)[..16]`，
//!    与既有 `root_key`（Node path.resolve 口径，契约 §2.1，**禁止** canonicalize）
//!    互不影响——主区身份逐字节不变，挂载区另起一套稳定哈希。
//!
//! 判定全部为纯函数（零 IO、零 env），关系比较大小写无关（Windows NTFS 语义），
//! 分隔符统一反斜杠后按组件逐段比较——`H:\a\b` 与 `H:\a\b2` 不会误判为父子。

use crate::error::GuanlanError;

/// 剥离 Windows 扩展路径前缀（plain() 语义）：
/// - `\\?\C:\foo\bar` → `C:\foo\bar`（长路径前缀）
/// - `\\?\UNC\server\share\foo` → `\\server\share\foo`（长路径 UNC 形式）
/// - 其余输入原样返回（含 `\\.\` 设备路径——无法无损 plain，保持原样交由上层拒绝）
///
/// 只剥前缀不改写分隔符：斜杠/相对段归一交给 win32 `resolve`（单一职责）。
pub fn strip_extended_prefix(path: &str) -> String {
    // 大小写无关匹配前缀（Windows 对设备前缀同样大小写无关）。
    // 必须用 get() 按字符边界取前缀：path.len() 是字节数，非 ASCII 路径
    // （如 `F:/观澜项目`）的第 8 字节可能落在多字节字符中间，直接 `path[..n]`
    // 会在启动挂载规范化阶段 panic（end byte index is not a char boundary）。
    let starts_with = |prefix: &str| {
        path.get(..prefix.len())
            .is_some_and(|head| head.eq_ignore_ascii_case(prefix))
    };
    if starts_with("\\\\?\\UNC\\") {
        // \\?\UNC\srv\share\x → \\srv\share\x（UNC 规范形式）
        format!("\\\\{}", &path[8..])
    } else if starts_with("\\\\?\\") {
        path[4..].to_owned()
    } else {
        path.to_owned()
    }
}

/// 参考工作区根路径规范化（挂载身份的单一入口）：
/// 1. 剥离 `\\?\` 扩展前缀（先剥再 resolve——`\\?\` 开头的输入走 resolve 的
///    设备根分支会保留前缀，且长路径输入可能超 win32 resolve 的常规形态）；
/// 2. win32 `path.resolve`（混合斜杠 / 相对段 / `..` 全部归一，契约 §2.1 同源移植）；
/// 3. resolve 后若仍残留 `\\?\` 前缀（病态嵌套设备路径）再剥一次；
/// 4. 收口尾部分隔符（UNC 根形式 `\\srv\share\` 去尾）。
///
/// 失败仅来自进程 cwd 不可无损表示（fail fast，对齐 [`crate::domain::resolve_root`]）。
pub fn normalize_mount_root(root_path: &str) -> Result<String, GuanlanError> {
    normalize_mount_root_with(root_path, &crate::domain::resolve_root)
}

/// 同 [`normalize_mount_root`]，但 cwd 解析由调用方注入（测试确定性用）。
pub fn normalize_mount_root_with(
    root_path: &str,
    resolver: &dyn Fn(&str) -> Result<String, GuanlanError>,
) -> Result<String, GuanlanError> {
    let stripped = strip_extended_prefix(root_path);
    let resolved = resolver(&stripped)?;
    let mut out = strip_extended_prefix(&resolved);
    // 尾部分隔符收口：UNC 根 resolve 结果带尾反斜杠（\\srv\share\），其余形态
    // resolve 已无尾分隔符；这里统一剥到无尾（`C:\` 盘根不受影响——剥的是尾，非根）
    while out.len() > 1 && out.ends_with('\\') {
        out.truncate(out.len() - 1);
    }
    Ok(out)
}

/// 挂载身份稳定哈希：`sha256(规范化绝对路径)` 前 16 hex。
/// 输入必须是 [`normalize_mount_root`] 的产物——长路径前缀 / 混合斜杠 / 尾分隔符
/// 已归一，同一目录不同写法哈希恒一致（验收「哈希稳定一致」）。
pub fn mount_key_of_resolved(normalized: &str) -> String {
    crate::domain::sha256_hex(normalized.as_bytes())[..16].to_owned()
}

/// 展示名：规范化路径的末段（`D:\archive\legacy-a` → `legacy-a`；盘根/UNC 根回退全路径）。
pub fn mount_display_name(normalized: &str) -> String {
    normalized
        .rsplit(['\\', '/'])
        .find(|seg| !seg.is_empty())
        .unwrap_or(normalized)
        .to_owned()
}

/// 两个规范化绝对路径的包含关系（大小写无关；组件级前缀——`ab` 不匹配 `a`）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PathRelation {
    /// 同一路径
    Equal,
    /// `a` 是 `b` 的祖先目录（a 包含 b）
    AncestorOf,
    /// `a` 是 `b` 的后代目录（b 包含 a）
    DescendantOf,
    /// 互不包含
    Disjoint,
}

/// 组件级包含判定。输入应为规范化路径（反斜杠、绝对）；函数内部仍防御性
/// 统一分隔符与尾分隔符，大小写无关比较。
pub fn path_relation(a: &str, b: &str) -> PathRelation {
    let norm = |p: &str| -> Vec<String> {
        let unified = strip_extended_prefix(p).replace('/', "\\");
        unified
            .split('\\')
            .filter(|seg| !seg.is_empty())
            .map(|seg| seg.to_lowercase())
            .collect()
    };
    let sa = norm(a);
    let sb = norm(b);
    if sa == sb {
        return PathRelation::Equal;
    }
    let (short, long, a_is_short) = if sa.len() < sb.len() {
        (&sa, &sb, true)
    } else {
        (&sb, &sa, false)
    };
    let is_prefix = long.len() > short.len() && long[..short.len()].iter().eq(short.iter());
    if !is_prefix {
        return PathRelation::Disjoint;
    }
    if a_is_short {
        PathRelation::AncestorOf
    } else {
        PathRelation::DescendantOf
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::assert_code;

    const CWD: &str = "H:\\";

    fn resolve_inject(p: &str) -> Result<String, GuanlanError> {
        Ok(crate::domain::resolve_root_with(p, CWD))
    }

    fn norm(p: &str) -> String {
        normalize_mount_root_with(p, &resolve_inject).expect("规范化失败")
    }

    /// 回归：非 ASCII 根路径不得在扩展前缀探测时 panic。
    /// `F:/观澜项目` 的第 8 字节落在多字节字符「澜」中间，旧实现直接
    /// `path[..8]` 会以 `not a char boundary` 在启动阶段崩掉整个进程。
    #[test]
    fn non_ascii_root_does_not_panic_on_prefix_probe() {
        for p in [
            "F:/观澜项目",
            "F:\\观澜项目",
            "C:/观澜项目工作区",
            "D:/数据/观澜项目",
        ] {
            assert_eq!(strip_extended_prefix(p), p);
        }
        // 真正的前缀仍必须剥离（尾段为中文同样安全）
        assert_eq!(strip_extended_prefix("\\\\?\\F:\\观澜项目"), "F:\\观澜项目");
        assert_eq!(
            strip_extended_prefix("\\\\?\\UNC\\srv\\分享\\观澜项目"),
            "\\\\srv\\分享\\观澜项目"
        );
        // 启动路径规范化链路（serv / 桌面壳均会走）不得 panic
        assert_eq!(norm("F:/观澜项目"), "F:\\观澜项目");
        assert_eq!(norm("\\\\?\\F:\\观澜项目"), "F:\\观澜项目");
    }

    /// 验收「Windows 长路径/混合斜杠目录规范化结果无 \\?\ 泄漏且哈希稳定一致」：
    /// 同一目录的四种写法归一到同一字符串、同一 mount_key
    #[test]
    fn plain_semantics_stable_hash_across_long_path_and_mixed_slashes() {
        let clean = norm(r"H:\archive\legacy-a");
        let long = norm(r"\\?\H:\archive\legacy-a");
        let mixed = norm("H:/archive/legacy-a/");
        let unc_long = norm(r"\\?\UNC\localhost\H$\archive\legacy-a");

        assert_eq!(clean, r"H:\archive\legacy-a");
        assert_eq!(long, clean, "长路径前缀必须剥离");
        assert_eq!(mixed, clean, "混合斜杠与尾分隔符必须归一");
        assert!(
            !unc_long.contains("\\\\?\\"),
            "UNC 长路径不得泄漏前缀：{unc_long}"
        );
        assert_eq!(unc_long, r"\\localhost\H$\archive\legacy-a");

        let k1 = mount_key_of_resolved(&long);
        let k2 = mount_key_of_resolved(&mixed);
        let k3 = mount_key_of_resolved(&clean);
        assert_eq!(k1, k2, "哈希对长路径写法稳定");
        assert_eq!(k1, k3, "哈希对混合斜杠写法稳定");
        assert_eq!(k1.len(), 16);
        // 规范化是幂等变换：规范化产物再规范化不动（挂载身份可重复推导）
        assert_eq!(norm(&clean), clean);
    }

    /// 相对路径按 win32 resolve 口径归一（与 root_key 同源移植，不新增第二套规则）
    #[test]
    fn relative_paths_resolve_against_cwd() {
        assert_eq!(norm("archive\\legacy-a"), r"H:\archive\legacy-a");
        assert_eq!(norm("./archive/./legacy-a"), r"H:\archive\legacy-a");
    }

    /// 展示名取末段；盘根与 UNC 根回退
    #[test]
    fn display_name_takes_last_segment() {
        assert_eq!(mount_display_name(r"H:\archive\legacy-a"), "legacy-a");
        assert_eq!(mount_display_name("H:\\"), "H:");
        assert_eq!(mount_display_name(r"\\srv\share"), "share");
    }

    /// 父子互斥判定：相等 / 祖先 / 后代 / 无关；大小写无关；`ab` 不是 `a` 的子目录
    #[test]
    fn path_relation_component_wise_and_case_insensitive() {
        let a = r"H:\work";
        assert_eq!(path_relation(a, r"h:\WORK"), PathRelation::Equal);
        assert_eq!(path_relation(a, r"H:\work\sub"), PathRelation::AncestorOf);
        assert_eq!(path_relation(r"H:\work\sub", a), PathRelation::DescendantOf);
        assert_eq!(path_relation(a, r"H:\other"), PathRelation::Disjoint);
        assert_eq!(
            path_relation(a, r"H:\work2"),
            PathRelation::Disjoint,
            "组件级前缀，不得按字符前缀误判"
        );
        assert_eq!(
            path_relation(a, r"I:\work"),
            PathRelation::Disjoint,
            "跨盘无关"
        );
        // 防御性容忍混合分隔符与尾分隔符（调用方应传规范化路径）
        assert_eq!(
            path_relation("H:/work/", r"h:\work\sub"),
            PathRelation::AncestorOf
        );
    }

    /// 设备路径 `\\.\` 不属于可 plain 化的挂载形态：原样保留，交给互斥/存在性校验拒绝
    #[test]
    fn device_paths_are_left_untouched() {
        assert_eq!(
            strip_extended_prefix(r"\\.\PHYSICALDRIVE0"),
            r"\\.\PHYSICALDRIVE0"
        );
        assert_eq!(strip_extended_prefix(r"\\?\C:\x"), r"C:\x");
        assert_eq!(strip_extended_prefix(r"\\\\?\UNC\srv"), r"\\\\?\UNC\srv");
    }

    /// cwd 不可无损表示时 fail fast（错误码 NOT 兜底吞掉——身份哈希绝不静默漂移）
    #[test]
    fn normalize_propagates_resolver_error() {
        let boom = |_p: &str| -> Result<String, GuanlanError> {
            Err(GuanlanError::Internal("cwd 不可用".to_owned()))
        };
        let err = normalize_mount_root_with("H:\\x", &boom).expect_err("应传播");
        assert_code(Err(err), "INTERNAL");
    }
}
