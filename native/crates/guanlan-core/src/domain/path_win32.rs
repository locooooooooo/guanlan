//! Node `path.win32` 的逐字移植（resolve / join / normalize / normalizeString）。
//!
//! 移植依据：Node v24 源码 lib/path.js：
//! - `resolve`：190-344 行；`normalize`：350-481 行；`join`：506-599 行；
//! - `normalizeString`：92-154 行；`isPathSeparator`/`isWindowsReservedName`/
//!   `isWindowsDeviceRoot`：65-89 行。
//!
//! 契约要求（contract-storage.md §2.1，全部逐字兼容）：rootKey 的哈希输入是
//! `path.resolve(rootPath)` 的返回字符串；Rust 严禁用 `std::fs::canonicalize` 或
//! `dunce::canonicalize` 替代（Windows 会引入 `\\?\` 前缀导致哈希不同）。
//!
//! 实现说明：
//! - Node 按 UTF-16 码元处理字符串；本移植按 UTF-8 字节处理。所有下标运算只落在
//!   ASCII 字符（分隔符 `/\`、点、冒号、盘符字母）上，按 ASCII 边界切分对任意
//!   UTF-8 输入（含中文路径）与 UTF-16 口径恒等；
//! - `process.cwd()` 由调用方注入（测试需要固定 cwd）；进程默认取 `std::env`；
//! - 盘符专属工作目录（Node 读取 `process.env['=D:']`）同样由调用方注入，
//!   缺省读真实环境变量。

fn is_sep(code: u8) -> bool {
    code == b'/' || code == b'\\'
}

fn is_device_root(code: u8) -> bool {
    code.is_ascii_alphabetic()
}

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

fn is_windows_reserved_name(path: &str, colon_index: isize) -> bool {
    let len = path.len() as isize;
    let end = if colon_index < 0 {
        (len + colon_index).max(0) as usize
    } else {
        (colon_index as usize).min(path.len())
    };
    let device_part = String::from_utf8_lossy(&path.as_bytes()[..end]).to_uppercase();
    WINDOWS_RESERVED_NAMES.contains(&device_part.as_str())
}

pub(crate) fn normalize_string(path: &str, allow_above_root: bool) -> String {
    let bytes = path.as_bytes();
    let mut res = String::new();
    let mut last_segment_length: isize = 0;
    let mut last_slash: isize = -1;
    let mut dots: i64 = 0;
    let mut code: u8 = 0;
    for i in 0..=bytes.len() {
        if i < bytes.len() {
            code = bytes[i];
        } else if is_sep(code) {
            break;
        } else {
            code = b'/';
        }

        if is_sep(code) {
            if last_slash == i as isize - 1 || dots == 1 {
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

    let lo: isize = -(1);
    let hi: isize = args.len() as isize - 1;
    for i in (lo..=hi).rev() {
        let path: String;
        if i >= 0 {
            path = args[i as usize].to_owned();
            if path.is_empty() {
                continue;
            }
        } else if resolved_device.is_empty() {
            path = cwd.to_owned();
            let fast =
                args.is_empty() || (args.len() == 1 && (args[0].is_empty() || args[0] == "."));
            if fast && cwd.as_bytes().first().copied().is_some_and(is_sep) {
                #[cfg(not(windows))]
                return path.replace('/', "\\");
                #[cfg(windows)]
                return path;
            }
        } else {
            let candidate = drive_cwd(&resolved_device).unwrap_or_else(|| cwd.to_owned());
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

        let bytes = path.as_bytes();
        let len = bytes.len();
        let mut root_end: usize = 0;
        let mut device = String::new();
        let mut is_absolute = false;
        let code = bytes.first().copied();

        if len == 1 {
            if code.is_some_and(is_sep) {
                root_end = 1;
                is_absolute = true;
            }
        } else if code.is_some_and(is_sep) {
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
                                device = format!("\\\\{first_part}\\{}", &path[last..j]);
                                root_end = j;
                            } else {
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
            device = path[0..2].to_owned();
            root_end = 2;
            if len > 2 && bytes.get(2).copied().is_some_and(is_sep) {
                is_absolute = true;
                root_end = 3;
            }
        }

        if !device.is_empty() {
            if !resolved_device.is_empty() {
                if device.to_lowercase() != resolved_device.to_lowercase() {
                    continue;
                }
            } else {
                resolved_device = device;
            }
        }

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

    let mut segments: Vec<String> = Vec::new();
    let mut part = String::new();
    let mut it = joined.chars().peekable();
    while let Some(ch) = it.next() {
        if ch == '\\' {
            if !part.is_empty() {
                segments.push(std::mem::take(&mut part));
            }
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
                            device = Some(format!("\\\\{first_part}"));
                            root_end = 4;
                            let colon_index = path.find(':');
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
                            return format!("\\\\{first_part}\\{}\\", &path[last..]);
                        } else {
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
