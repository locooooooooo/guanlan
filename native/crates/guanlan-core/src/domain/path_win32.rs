//! Node `path.win32` 的逐字移植（resolve / join / normalize / normalizeString）。
//!
//! 移植依据：Node v24 源码 lib/path.js（本会话从
//! https://raw.githubusercontent.com/nodejs/node/main/lib/path.js 取得原文）：
//! - `resolve`：190-344 行；`normalize`：350-481 行；`join`：506-599 行；
//! - `normalizeString`：92-154 行；`isPathSeparator`/`isWindowsReservedName`/
//!   `isWindowsDeviceRoot`：65-89 行。
//!
//! 契约要求（contract-storage.md §2.1，全部逐字兼容）：rootKey 的哈希输入是
//! `path.resolve(rootPath)` 的返回字符串；Rust 严禁用 `std::fs::canonicalize` 或
//! `dunce::canonicalize` 替代（Windows 会引入 `\\?\` 前缀导致哈希不同，
//! docs/guanlan/观澜-Rust服务拆分方案-v0.1.md:140）。
//!
//! 实现说明：
//! - Node 按 UTF-16 码元处理字符串；本移植按 UTF-8 字节处理。所有下标运算只落在
//!   ASCII 字符（分隔符 `/\`、点、冒号、盘符字母）上，按 ASCII 边界切分对任意
//!   UTF-8 输入（含中文路径）与 UTF-16 口径恒等；
//! - `process.cwd()` 由调用方注入（测试需要固定 cwd）；进程默认取 `std::env`；
//! - 盘符专属工作目录（Node 读取 `process.env['=D:']`）同样由调用方注入，
//!   缺省读真实环境变量。

/// `isPathSeparator`（node-path.js:65-67）：`/` 或 `\`
fn is_sep(code: u8) -> bool {
    code == b'/' || code == b'\\'
}

/// `isWindowsDeviceRoot`（node-path.js:86-89）：ASCII 字母
fn is_device_root(code: u8) -> bool {
    code.is_ascii_alphabetic()
}

/// Windows 保留设备名（node-path.js:73-79；`COM¹` 等为 U+00B9/U+00B2/U+00B3）
const WINDOWS_RESERVED_NAMES: [&str; 28] = [
    "CON",
    "PRN",
    "AUX",
    "NUL",
    "COM1",
    "COM2",
    "COM3",
    "COM4",
    "COM5",
    "COM6",
    "COM7",
    "COM8",
    "COM9",
    "LPT1",
    "LPT2",
    "LPT3",
    "LPT4",
    "LPT5",
    "LPT6",
    "LPT7",
    "LPT8",
    "LPT9",
    "COM\u{b9}",
    "COM\u{b2}",
    "COM\u{b3}",
    "LPT\u{b9}",
    "LPT\u{b2}",
    "LPT\u{b3}",
];

/// `isWindowsReservedName`（node-path.js:81-84）。
/// `colon_index` 可为负（JS 调用点会传 -1）：`slice(0, -1)` = 去掉最后一个字符。
/// 结尾若落在多字节字符中间，按有损 UTF-8 转换比较——保留名全为 ASCII，不会误判。
fn is_windows_reserved_name(path: &str, colon_index: isize) -> bool {
    let len = path.len() as isize;
    // Node String.prototype.slice(0, n)：负数 n 按长度折算，越界截断
    let end = if colon_index < 0 {
        (len + colon_index).max(0) as usize
    } else {
        (colon_index as usize).min(path.len())
    };
    let device_part = String::from_utf8_lossy(&path.as_bytes()[..end]).to_uppercase();
    WINDOWS_RESERVED_NAMES.contains(&device_part.as_str())
}

/// `normalizeString`（node-path.js:92-154，separator 恒为 `\`）。
/// 逐字移植：lastSlash/lastSegmentLength 用 isize 承载 JS 的 -1 语义。
pub(crate) fn normalize_string(path: &str, allow_above_root: bool) -> String {
    let bytes = path.as_bytes();
    let mut res = String::new();
    let mut last_segment_length: isize = 0;
    let mut last_slash: isize = -1;
    let mut dots: i64 = 0;
    let mut code: u8 = 0;
    // JS: for (let i = 0; i <= path.length; ++i)（continue 仍会 ++i）
    for i in 0..=bytes.len() {
        if i < bytes.len() {
            code = bytes[i];
        } else if is_sep(code) {
            break;
        } else {
            // 收尾补一个分隔符触发末端段处理（node-path.js:104）
            code = b'/';
        }

        if is_sep(code) {
            if last_slash == i as isize - 1 || dots == 1 {
                // NOOP（node-path.js:107-108）
            } else if dots == 2 {
                let res_bytes = res.as_bytes();
                if res.len() < 2
                    || last_segment_length != 2
                    || res_bytes[res.len() - 1] != b'.'
                    || res_bytes[res.len() - 2] != b'.'
                {
                    if res.len() > 2 {
                        let last_slash_index = res.len() as isize - last_segment_length - 1;
                        if last_slash_index == -1 {
                            res.clear();
                            last_segment_length = 0;
                        } else {
                            res.truncate(last_slash_index as usize);
                            last_segment_length = res.len() as isize
                                - 1
                                - res.rfind('\\').map(|p| p as isize).unwrap_or(-1);
                        }
                        last_slash = i as isize;
                        dots = 0;
                        continue;
                    } else if !res.is_empty() {
                        res.clear();
                        last_segment_length = 0;
                        last_slash = i as isize;
                        dots = 0;
                        continue;
                    }
                }
                if allow_above_root {
                    if !res.is_empty() {
                        res.push_str("\\..");
                    } else {
                        res.push_str("..");
                    }
                    last_segment_length = 2;
                }
            } else {
                let start = (last_slash + 1).max(0) as usize;
                let segment = &path[start..i];
                if !res.is_empty() {
                    res.push('\\');
                    res.push_str(segment);
                } else {
                    res.push_str(segment);
                }
                last_segment_length = (i - start) as isize;
            }
            last_slash = i as isize;
            dots = 0;
        } else if code == b'.' && dots != -1 {
            dots += 1;
        } else {
            dots = -1;
        }
    }
    res
}

/// `path.win32.resolve(...args)`（node-path.js:190-344）。
///
/// * `cwd`：`process.cwd()` 的注入值；
/// * `drive_cwd`：盘符专属工作目录（Node 读 `process.env['=D:']`）的注入值；
///   缺省（无该盘记录）回退 `cwd`，与 Node 的 `|| process.cwd()` 一致。
pub fn resolve_with(
    args: &[&str],
    cwd: &str,
    drive_cwd: &dyn Fn(&str) -> Option<String>,
) -> String {
    let mut resolved_device = String::new();
    let mut resolved_tail = String::new();
    let mut resolved_absolute = false;

    // JS: for (let i = args.length - 1; i >= -1; i--)
    let lo: isize = -(1);
    let hi: isize = args.len() as isize - 1;
    for i in (lo..=hi).rev() {
        let path: String;
        if i >= 0 {
            path = args[i as usize].to_owned();
            // 空参数跳过（node-path.js:201-204）
            if path.is_empty() {
                continue;
            }
        } else if resolved_device.is_empty() {
            path = cwd.to_owned();
            // 快路径（node-path.js:207-214）：仅在无参数（或唯一参数为空/`.`）且
            // cwd 以分隔符开头时触发；Windows 的 cwd 以盘符开头，通常不触发
            let fast =
                args.is_empty() || (args.len() == 1 && (args[0].is_empty() || args[0] == "."));
            if fast && cwd.as_bytes().first().copied().is_some_and(is_sep) {
                // node-path.js:210-212 的 !isWindows 分支：非 Windows 宿主上把正斜杠
                // 换成反斜杠；本服务以 win32 口径为准
                #[cfg(not(windows))]
                return path.replace('/', "\\");
                #[cfg(windows)]
                return path;
            }
        } else {
            // 盘符专属 cwd（node-path.js:215-231）：`=D:` 环境变量，缺省回退进程 cwd
            let candidate = drive_cwd(&resolved_device).unwrap_or_else(|| cwd.to_owned());
            // 校验 cwd 是否确属该盘（前两字符大小写无关相等），否则回退盘符根 `D:\`
            let device_prefix = &resolved_device;
            let same_drive = candidate
                .get(0..2)
                .is_some_and(|p| p.to_lowercase() == device_prefix.to_lowercase());
            let third_is_backslash = candidate.as_bytes().get(2) == Some(&b'\\');
            path = if !same_drive && third_is_backslash {
                format!("{resolved_device}\\")
            } else {
                candidate
            };
        }

        // 根段匹配（node-path.js:233-307）
        let bytes = path.as_bytes();
        let len = bytes.len();
        let mut root_end: usize = 0;
        let mut device = String::new();
        let mut is_absolute = false;
        let code = bytes.first().copied();

        if len == 1 {
            if code.is_some_and(is_sep) {
                // 单个分隔符 = 当前盘根（node-path.js:240-245）
                root_end = 1;
                is_absolute = true;
            }
        } else if code.is_some_and(is_sep) {
            // 可能的 UNC / 设备根（node-path.js:246-295）
            is_absolute = true;
            if bytes.get(1).copied().is_some_and(is_sep) {
                let mut j: usize = 2;
                let mut last: usize = j;
                while j < len && !is_sep(bytes[j]) {
                    j += 1;
                }
                if j < len && j != last {
                    let first_part = path[last..j].to_owned();
                    last = j;
                    while j < len && is_sep(bytes[j]) {
                        j += 1;
                    }
                    if j < len && j != last {
                        last = j;
                        while j < len && !is_sep(bytes[j]) {
                            j += 1;
                        }
                        if j == len || j != last {
                            if first_part != "." && first_part != "?" {
                                // UNC 根（node-path.js:280-284）
                                device = format!("\\\\{first_part}\\{}", &path[last..j]);
                                root_end = j;
                            } else {
                                // 设备根，如 \\.\PHYSICALDRIVE0（node-path.js:285-289）
                                device = format!("\\\\{first_part}");
                                root_end = 4;
                            }
                        }
                    }
                }
            } else {
                root_end = 1;
            }
        } else if code.is_some_and(is_device_root) && bytes.get(1) == Some(&b':') {
            // 盘符根（node-path.js:296-307）
            device = path[0..2].to_owned();
            root_end = 2;
            if len > 2 && bytes.get(2).copied().is_some_and(is_sep) {
                is_absolute = true;
                root_end = 3;
            }
        }

        // 设备归并（node-path.js:309-318）：不同盘的路径不适用，跳过该段
        if !device.is_empty() {
            if !resolved_device.is_empty() {
                if device.to_lowercase() != resolved_device.to_lowercase() {
                    continue;
                }
            } else {
                resolved_device = device;
            }
        }

        // 尾段归并（node-path.js:320-330）
        if resolved_absolute {
            if !resolved_device.is_empty() {
                break;
            }
        } else {
            resolved_tail = format!("{}\\{}", &path[root_end..], resolved_tail);
            resolved_absolute = is_absolute;
            if is_absolute && !resolved_device.is_empty() {
                break;
            }
        }
    }

    // 归一化尾段并拼装（node-path.js:337-343）
    let tail = normalize_string(&resolved_tail, !resolved_absolute);
    if resolved_absolute {
        format!("{resolved_device}\\{tail}")
    } else {
        let joined = format!("{resolved_device}{tail}");
        if joined.is_empty() {
            ".".to_owned()
        } else {
            joined
        }
    }
}

/// `path.win32.join(...args)`（node-path.js:506-599）。
pub fn join_with(args: &[&str]) -> String {
    if args.is_empty() {
        return ".".to_owned();
    }
    let parts: Vec<&str> = args.iter().filter(|a| !a.is_empty()).copied().collect();
    if parts.is_empty() {
        return ".".to_owned();
    }
    let first_part = parts[0];
    let mut joined = parts.join("\\");

    // 防止 join 结果被 normalize 误判为 UNC（node-path.js:538-566）
    let mut needs_replace = true;
    let mut slash_count: usize = 0;
    let fb = first_part.as_bytes();
    if fb.first().copied().is_some_and(is_sep) {
        slash_count += 1;
        if fb.len() > 1 && is_sep(fb[1]) {
            slash_count += 1;
            if fb.len() > 2 {
                if is_sep(fb[2]) {
                    slash_count += 1;
                } else {
                    // 首段本来就是显式 UNC：不替换（node-path.js:549-552）
                    needs_replace = false;
                }
            }
        }
    }
    if needs_replace {
        let jb = joined.as_bytes();
        while slash_count < jb.len() && is_sep(jb[slash_count]) {
            slash_count += 1;
        }
        if slash_count >= 2 {
            joined = format!("\\{}", &joined[slash_count..]);
        }
    }

    // 保留名分段检查（node-path.js:568-596）：任一段含冒号且冒号前是保留名 →
    // 只把正斜杠换成反斜杠，跳过 normalize
    let mut segments: Vec<String> = Vec::new();
    let mut part = String::new();
    let mut it = joined.chars().peekable();
    while let Some(ch) = it.next() {
        if ch == '\\' {
            if !part.is_empty() {
                segments.push(std::mem::take(&mut part));
            }
            // 跳过连续反斜杠（node-path.js:576-577）
            while it.peek() == Some(&'\\') {
                it.next();
            }
        } else {
            part.push(ch);
        }
    }
    if !part.is_empty() {
        segments.push(part);
    }
    let has_reserved = segments.iter().any(|seg| {
        seg.find(':')
            .is_some_and(|ci| is_windows_reserved_name(seg, ci as isize))
    });
    if has_reserved {
        return joined.replace('/', "\\");
    }

    normalize(&joined)
}

/// `path.win32.normalize(path)`（node-path.js:350-481）。
pub fn normalize(path: &str) -> String {
    let len = path.len();
    if len == 0 {
        return ".".to_owned();
    }
    let bytes = path.as_bytes();
    let code = bytes[0];

    if len == 1 {
        // node-path.js:364 用 isPosixPathSeparator（仅 '/'）：单个 '\' 原样返回
        return if code == b'/' {
            "\\".to_owned()
        } else {
            path.to_owned()
        };
    }

    let mut root_end: usize = 0;
    let mut device: Option<String> = None;
    let mut is_absolute = false;

    if is_sep(code) {
        // 可能的 UNC / 设备根（node-path.js:366-427）
        is_absolute = true;
        if is_sep(bytes[1]) {
            let mut j: usize = 2;
            let mut last: usize = j;
            while j < len && !is_sep(bytes[j]) {
                j += 1;
            }
            if j < len && j != last {
                let first_part = path[last..j].to_owned();
                last = j;
                while j < len && is_sep(bytes[j]) {
                    j += 1;
                }
                if j < len && j != last {
                    last = j;
                    while j < len && !is_sep(bytes[j]) {
                        j += 1;
                    }
                    if j == len || j != last {
                        if first_part == "." || first_part == "?" {
                            // 设备根（node-path.js:400-410）
                            device = Some(format!("\\\\{first_part}"));
                            root_end = 4;
                            // 特例：\\?\COM1: 之类保留设备路径
                            let colon_index = path.find(':');
                            // JS slice(4, colonIndex + 1)：无冒号时为 slice(4, 0) = ''
                            let possible_device = match colon_index {
                                Some(ci) if ci + 1 > 4 => &path[4..ci + 1],
                                _ => "",
                            };
                            if is_windows_reserved_name(
                                possible_device,
                                possible_device.len() as isize - 1,
                            ) {
                                device = Some(format!("\\\\?\\{possible_device}"));
                                root_end = 4 + possible_device.len();
                            }
                        } else if j == len {
                            // 仅 UNC 根（node-path.js:411-415）
                            return format!("\\\\{first_part}\\{}\\", &path[last..]);
                        } else {
                            // UNC 根 + 余段（node-path.js:416-421）
                            device = Some(format!("\\\\{first_part}\\{}", &path[last..j]));
                            root_end = j;
                        }
                    }
                }
            }
        } else {
            root_end = 1;
        }
    } else {
        // 非分隔符开头：盘符或保留名设备（node-path.js:428-444）
        if let Some(ci) = path.find(':') {
            if ci > 0 {
                if is_device_root(code) && ci == 1 {
                    device = Some(path[0..2].to_owned());
                    root_end = 2;
                    if len > 2 && is_sep(bytes[2]) {
                        is_absolute = true;
                        root_end = 3;
                    }
                } else if is_windows_reserved_name(path, ci as isize) {
                    device = Some(path[0..ci + 1].to_owned());
                    root_end = ci + 1;
                }
            }
        }
    }

    let mut tail = if root_end < len {
        normalize_string(&path[root_end..], !is_absolute)
    } else {
        String::new()
    };
    if tail.is_empty() && !is_absolute {
        tail = ".".to_owned();
    }
    if !tail.is_empty() && is_sep(bytes[len - 1]) {
        tail.push('\\');
    }

    // CVE-2024-36139 防护（node-path.js:455-472）：非绝对且未解析出设备时，
    // 尾段不得以「Windows 会解释为绝对路径」的形式开头
    if !is_absolute && device.is_none() && path.contains(':') {
        if tail.len() >= 2 && is_device_root(tail.as_bytes()[0]) && tail.as_bytes()[1] == b':' {
            return format!(".\\{tail}");
        }
        let mut index = match path.find(':') {
            Some(i) => i,
            None => return format!(".\\{tail}"),
        };
        loop {
            if index == len - 1 || (index + 1 < len && is_sep(bytes[index + 1])) {
                return format!(".\\{tail}");
            }
            match path[index + 1..].find(':') {
                Some(off) => index += off + 1,
                None => break,
            }
        }
    }
    // 保留名整体兜底（node-path.js:473-476）：无冒号时 colonIndex=-1 →
    // slice(0, -1) = 去掉最后一个字符（node 的怪癖，照抄）
    let colon_index = path.find(':').map(|c| c as isize).unwrap_or(-1);
    if is_windows_reserved_name(path, colon_index) {
        return format!(".\\{}{}", device.as_deref().unwrap_or(""), tail);
    }

    match device {
        None => {
            if is_absolute {
                format!("\\{tail}")
            } else {
                tail
            }
        }
        Some(d) => {
            if is_absolute {
                format!("{d}\\{tail}")
            } else {
                format!("{d}{tail}")
            }
        }
    }
}
