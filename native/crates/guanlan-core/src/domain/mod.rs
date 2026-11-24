//! 领域规则：身份、版本、事件、时间与证据规则（方案 §2）。
//!
//! 契约来源：native/docs/contract-storage.md
//! - §2 身份规则（全部逐字兼容）：rootKey（Node `path.resolve` + SHA-256 前 16 hex，
//!   **禁止**用 `canonicalize` 替代）、workspace_id / file_id / revision_id 生成模板；
//! - §5 读取相关历史语义：内容未变不增版本、纯日期不补午夜不做时区换算、
//!   发生/采集/来源/精度四字段独立、A→B→A 三次版本出现两份内容。
//!
//! 本批（批次一）落地读取侧所需的部分：rootKey / workspace_id / file_id /
//! revision_id 的精确兼容实现。批次二已补写入侧所需的事件身份要素：
//! `stable_short`（事件 id 里的路径/状态短摘要）与 `uniq_event_identity`
//! 去重语义的写入侧实现（见 [`crate::index::writer`]）。
//!
//! 平台口径：观澜是 Windows 本地应用，rootKey 身份以 Node win32 `path.resolve`
//! 为准绳（契约 §2.1），因此在所有平台上统一按 win32 规则求值，不随编译目标切换。

pub(crate) mod path_win32;

/// 领域模型（PRD v2.0 §2.1 四层资产）：Initiative / Artifact / DecisionItem
pub mod candidate_weaver;
pub mod model;

/// C02 混合倒排索引分词器：建索引侧与查询侧共用的纯函数规则（契约 §2.4）
pub mod search_tokens;

/// C05 跨项目只读挂载：参考工作区路径规范化（plain() 语义）、父子互斥判定与
/// 挂载身份稳定哈希（契约 contract-storage.md §13）
pub mod mounts;

/// E01 丞相台四车道可解释分流（`inform / login / decide / delegate`）与
/// 五道安全闸 fail-closed 政策守门（吸收主仓 `workflow-triage.js` + `workflow-policy.js`）
pub mod triage;

#[cfg(test)]
#[path = "vectors_fixture_test.rs"]
mod vectors_fixture_test;

use sha2::{Digest, Sha256};

use crate::error::GuanlanError;

/// SHA-256 的完整小写十六进制摘要（service 写线程 CAS/草案哈希共用）
pub fn sha256_hex(data: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(data);
    hex::encode(hasher.finalize())
}

/// Node `path.resolve(rootPath)`（win32 口径）。
/// cwd 取 `std::env::current_dir()`，盘符专属 cwd 取 `=X:` 环境变量——
/// 与 Node 进程行为一致。
///
/// cwd 必须能无损转 UTF-8（`to_str()` 为 None：Windows UTF-16 中的未配对代理项
/// 或非 Windows 的非法字节）。此类路径无法进入 rootKey 的 UTF-8 字节哈希口径，
/// 与 Node（UTF-16 码元）的身份计算不一致——`to_string_lossy()` 会静默替换成
/// U+FFFD 落到另一个数据目录，故 fail fast 拒绝启动（path_win32.rs:15-17 口径注）。
pub fn resolve_root(root_path: &str) -> Result<String, GuanlanError> {
    let cwd_path = std::env::current_dir()
        .map_err(|e| GuanlanError::Internal(format!("读取进程 cwd 失败: {e}")))?;
    let cwd = cwd_path.to_str().ok_or_else(|| {
        GuanlanError::Internal(
            "进程 cwd 含无法按 UTF-8 无损表示的字符：rootKey 身份口径将与 Node 不一致，拒绝启动以避免静默解析到其他数据目录"
                .to_owned(),
        )
    })?;
    Ok(resolve_root_with(root_path, cwd))
}

/// 同 [`resolve_root`]，但 cwd 由调用方注入（测试与工具场景用）。
pub fn resolve_root_with(root_path: &str, cwd: &str) -> String {
    path_win32::resolve_with(&[root_path], cwd, &drive_cwd_from_env)
}

/// 盘符专属工作目录：Node 读 `process.env['=D:']`（cmd.exe 维护的隐藏变量）。
/// 环境变量缺失或非 UTF-8 时返回 None，回退进程 cwd（与 Node 的 `||` 一致）。
fn drive_cwd_from_env(device: &str) -> Option<String> {
    std::env::var(format!("={device}")).ok()
}

/// rootKey（契约 §2.1 [逐字兼容]）：
/// `sha256(path.resolve(rootPath))` 的小写十六进制前 16 个字符（前 8 字节）。
pub fn root_key_of_resolved(resolved: &str) -> String {
    sha256_hex(resolved.as_bytes())[..16].to_owned()
}

/// rootKey = 哈希输入是 `path.resolve(rootPath)` 的返回字符串，
/// 不是原始参数、不是 canonicalize 结果（契约 §2.1 第 1 条）。
pub fn root_key_of(root_path: &str) -> Result<String, GuanlanError> {
    Ok(root_key_of_resolved(&resolve_root(root_path)?))
}

/// workspace_id（契约 §2.2）：`'ws_' + rootKeyOf(resolved)`
pub fn workspace_id_of(root_key: &str) -> String {
    format!("ws_{root_key}")
}

/// 相对路径规范化（reconcile.ts:76-78）：反斜杠 → 正斜杠
pub fn normalize_rel_path(p: &str) -> String {
    p.replace('\\', "/")
}

/// file_id（契约 §2.3 [逐字兼容]，reconcile.ts:84-90）：
/// `f_` + sha256(`${rootKey}|${斜杠规范化后的小写相对路径}`) 前 24 个十六进制字符。
/// 小写化取 Unicode 默认小写（与 JS `toLowerCase()` 同口径，非 locale 感知）。
pub fn stable_file_id(root_key: &str, relative_path: &str) -> String {
    let input = format!(
        "{root_key}|{}",
        normalize_rel_path(relative_path).to_lowercase()
    );
    format!("f_{}", &sha256_hex(input.as_bytes())[..24])
}

/// revision_id（契约 §2.4，reconcile.ts:92-94）：`fileId + '_r' + seq`
pub fn revision_id_of(file_id: &str, seq: i64) -> String {
    format!("{file_id}_r{seq}")
}

/// 夹具向量文件路径：native/testdata/identity-vectors.json（仅测试使用）
#[cfg(test)]
/// （由 scripts/seed-fixture.ts 生成，见下方测试的缺失提示）
const IDENTITY_VECTORS_PATH: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../testdata/identity-vectors.json"
);

/// 测试提前返回（跳过）时调用，代替直接 `eprintln!("[skip] …")`。
///
/// libtest 会截获通过的测试打印的内容，所以直接打印的 `[skip]` 在 `cargo test` 的输出里
/// 看不到，一份「381 通过」里会混着什么都没验证的测试。设了 `GUANLAN_TEST_SKIP_LOG`
/// 时（`npm run gate` 会设），把「测试名: 原因」追加到那个文件，门禁据此在运行记录里
/// 点名被跳过的测试。没设时只打印，与此前一样。
#[cfg(test)]
pub(crate) fn note_skipped(reason: impl std::fmt::Display) {
    eprintln!("[skip] {reason}");
    let Ok(path) = std::env::var("GUANLAN_TEST_SKIP_LOG") else {
        return;
    };
    append_skip(&path, reason);
}

/// [`note_skipped`] 的落盘部分。路径由调用方给出：单测直接调它，不去改进程的环境变量
/// （测试是并行跑的，改了会影响别的测试）。写不进去也不让测试失败，跳过的提示只是提示。
#[cfg(test)]
fn append_skip(path: &str, reason: impl std::fmt::Display) {
    use std::io::Write;
    // 整行拼好再写一次。直接 writeln!(file, …) 会把一行拆成几次 write，两个测试同时
    // 跳过时字会交错（实测出现过）。
    let current = std::thread::current();
    let name = current.name().unwrap_or("(未知测试名)");
    let line = format!("{name}: {reason}\n");
    let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
    else {
        return;
    };
    let _ = file.write_all(line.as_bytes());
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 本测试专用的临时目录，离开作用域时删除。删除不能只靠测试末尾的那一句：断言失败时
    /// 走不到它，目录就留在临时文件夹里（做弄坏验证时留下过上百个）。
    struct ScratchDir(std::path::PathBuf);

    impl ScratchDir {
        fn new(tag: &str) -> Self {
            // 名字里带进程 ID 与纳秒时间：上一次运行没删干净时不会读到旧记录
            let nanos = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or_default();
            let dir = std::env::temp_dir().join(format!(
                "guanlan-skip-log-{tag}-{}-{nanos}",
                std::process::id()
            ));
            std::fs::create_dir_all(&dir).expect("建临时目录");
            Self(dir)
        }

        /// 目录里一个文件的路径，可以直接传给 [`append_skip`]
        fn file(&self, name: &str) -> String {
            self.0
                .join(name)
                .to_str()
                .expect("临时路径是合法 UTF-8")
                .to_string()
        }
    }

    impl Drop for ScratchDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn read_lines(path: &str) -> Vec<String> {
        std::fs::read_to_string(path)
            .expect("读回跳过记录")
            .lines()
            .map(str::to_string)
            .collect()
    }

    /// 跳过记录带上测试的完整路径名与原因，并且是追加而不是覆盖
    #[test]
    fn skip_log_appends_test_name_and_reason() {
        let dir = ScratchDir::new("append");
        let path = dir.file("skips.log");
        append_skip(&path, "夹具不存在");
        append_skip(&path, format!("另一个原因：{}", 1 + 1));
        let lines = read_lines(&path);
        assert_eq!(lines.len(), 2, "{lines:?}");
        let prefix = "domain::tests::skip_log_appends_test_name_and_reason: ";
        assert_eq!(lines[0], format!("{prefix}夹具不存在"));
        assert_eq!(lines[1], format!("{prefix}另一个原因：2"));
    }

    /// 几个测试同时跳过时，每条记录各占一行、互不交错。门禁按行数点名，交错会让两条并成一条。
    #[test]
    fn skip_log_lines_do_not_interleave_when_tests_skip_concurrently() {
        let dir = ScratchDir::new("race");
        let path = dir.file("skips.log");
        let writers: Vec<_> = (0..8)
            .map(|thread| {
                let path = path.clone();
                std::thread::spawn(move || {
                    for i in 0..10 {
                        append_skip(&path, format!("原因 {thread}-{i}"));
                    }
                })
            })
            .collect();
        for writer in writers {
            writer.join().expect("写跳过记录的线程不该 panic");
        }
        let lines = read_lines(&path);
        assert_eq!(lines.len(), 80, "{lines:?}");
        for line in &lines {
            assert!(
                line.starts_with("(未知测试名): 原因 ")
                    && line.ends_with(|c: char| c.is_ascii_digit()),
                "有交错的行：{line:?}"
            );
        }
    }

    /// 断言失败时临时目录也要删掉：靠 Drop，不靠测试末尾的那一句
    #[test]
    fn scratch_dir_is_removed_even_when_the_test_panics() {
        let dir = ScratchDir::new("drop");
        let path = dir.0.clone();
        assert!(path.is_dir());
        let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(move || {
            let _kept_until_unwind = dir;
            panic!("模拟一条断言失败");
        }));
        assert!(outcome.is_err(), "闭包应当 panic");
        assert!(
            !path.exists(),
            "临时目录没有随作用域结束而删除：{}",
            path.display()
        );
    }

    /// 契约 §2.1/§2.3 明列的具体值 + 本会话 node v24.19.0 实测补充
    /// （实测命令见会话记录：`node gen.mjs` 用与源码逐字相同的算法计算）。
    #[test]
    fn contract_stated_identity_values() {
        let cwd = r"C:\Users\34689\AppData\Local\Temp\rslv-vectors";
        // 契约 §2.1 示例：D:\notebooks\demo → 6d74a29df40616ec
        assert_eq!(
            root_key_of_resolved(&path_win32::resolve_with(
                &[r"D:\notebooks\demo"],
                cwd,
                &|_| None
            )),
            "6d74a29df40616ec"
        );
        // 盘符大小写原样保留（契约 §2.1 第 2 条实测）：小写盘符是另一个 rootKey
        assert_eq!(
            root_key_of_resolved(&path_win32::resolve_with(
                &["d:/notebooks/demo"],
                cwd,
                &|_| None
            )),
            "4c04a8aa7634d59c"
        );
        // 契约 §2.3 示例：rootKey + Notes\ReadMe.MD → f_b967338b81904b60abf8374e
        assert_eq!(
            stable_file_id("6d74a29df40616ec", r"Notes\ReadMe.MD"),
            "f_b967338b81904b60abf8374e"
        );
        // 同一路径的正斜杠/大小写变体得到同一 file_id
        assert_eq!(
            stable_file_id("6d74a29df40616ec", "notes/readme.md"),
            "f_b967338b81904b60abf8374e"
        );
        // 中文路径（本会话实测）
        assert_eq!(
            root_key_of_resolved(&path_win32::resolve_with(
                &[r"D:\观澜\工作区"],
                cwd,
                &|_| None
            )),
            "df515ae695087507"
        );
        // revision_id 模板
        assert_eq!(
            revision_id_of("f_b967338b81904b60abf8374e", 1),
            "f_b967338b81904b60abf8374e_r1"
        );
        assert_eq!(workspace_id_of("6d74a29df40616ec"), "ws_6d74a29df40616ec");
    }

    /// 本会话采集的 resolve/join 向量：node v24.19.0 `path.win32.resolve/join`
    /// 对 60 个 resolve 输入与 12 个 join 输入的实际返回（脚本存于会话临时目录，
    /// cwd = "C:\\Users\\34689\\AppData\\Local\\Temp\\rslv-vectors"，一并注入）。
    /// JSON 结构：[输入, 期望输出]。
    const SESSION_VECTORS: &str = r#"{"cwd":"C:\\Users\\34689\\AppData\\Local\\Temp\\rslv-vectors","resolve":[["D:\\notebooks\\demo","D:\\notebooks\\demo"],["d:/notebooks/demo","d:\\notebooks\\demo"],["D:/notebooks/demo/","D:\\notebooks\\demo"],["D:","D:\\"],["d:","d:\\"],["D:\\\\","D:\\"],["D:/","D:\\"],["/","C:\\"],["\\","C:\\"],["D:\\notebooks\\..\\demo","D:\\demo"],["D:\\.\\notebooks\\demo","D:\\notebooks\\demo"],["D:\\notebooks\\\\demo","D:\\notebooks\\demo"],["D:\\notebooks\\demo\\..","D:\\notebooks"],["c:\\x\\y\\z\\..\\w","c:\\x\\y\\w"],["C:\\","C:\\"],["Z:/A/B","Z:\\A\\B"],["z:/a/b","z:\\a\\b"],["foo","C:\\Users\\34689\\AppData\\Local\\Temp\\rslv-vectors\\foo"],["foo\\bar","C:\\Users\\34689\\AppData\\Local\\Temp\\rslv-vectors\\foo\\bar"],["foo/bar","C:\\Users\\34689\\AppData\\Local\\Temp\\rslv-vectors\\foo\\bar"],["./foo","C:\\Users\\34689\\AppData\\Local\\Temp\\rslv-vectors\\foo"],[".\\foo","C:\\Users\\34689\\AppData\\Local\\Temp\\rslv-vectors\\foo"],["foo\\..\\bar","C:\\Users\\34689\\AppData\\Local\\Temp\\rslv-vectors\\bar"],["foo\\..\\..\\bar","C:\\Users\\34689\\AppData\\Local\\Temp\\bar"],[".","C:\\Users\\34689\\AppData\\Local\\Temp\\rslv-vectors"],["..","C:\\Users\\34689\\AppData\\Local\\Temp"],["...","C:\\Users\\34689\\AppData\\Local\\Temp\\rslv-vectors\\..."],["a//b","C:\\Users\\34689\\AppData\\Local\\Temp\\rslv-vectors\\a\\b"],["a/./b","C:\\Users\\34689\\AppData\\Local\\Temp\\rslv-vectors\\a\\b"],["a\\/.\\/b","C:\\Users\\34689\\AppData\\Local\\Temp\\rslv-vectors\\a\\b"],["a\\b\\","C:\\Users\\34689\\AppData\\Local\\Temp\\rslv-vectors\\a\\b"],["a\\b\\\\","C:\\Users\\34689\\AppData\\Local\\Temp\\rslv-vectors\\a\\b"],["C:a","C:\\Users\\34689\\AppData\\Local\\Temp\\rslv-vectors\\a"],["C:a\\b","C:\\Users\\34689\\AppData\\Local\\Temp\\rslv-vectors\\a\\b"],["C:.\\b","C:\\Users\\34689\\AppData\\Local\\Temp\\rslv-vectors\\b"],["C:..\\b","C:\\Users\\34689\\AppData\\Local\\Temp\\b"],["D:.\\x","D:\\x"],["D:..","D:\\"],["\\\\server\\share","\\\\server\\share\\"],["\\\\server\\share\\","\\\\server\\share\\"],["\\\\server\\share\\a\\b","\\\\server\\share\\a\\b"],["//server/share/a","\\\\server\\share\\a"],["\\\\?\\C:\\x\\y","\\\\?\\C:\\x\\y"],["\\\\?\\UNC\\server\\share\\a","\\\\?\\UNC\\server\\share\\a"],["\\\\.\\x","\\\\.\\x"],["\\\\a\\b","\\\\a\\b\\"],["\\\\a","C:\\a"],["\\\\\\","C:\\"],["","C:\\Users\\34689\\AppData\\Local\\Temp\\rslv-vectors"],[" ","C:\\Users\\34689\\AppData\\Local\\Temp\\rslv-vectors\\ "],["file.md","C:\\Users\\34689\\AppData\\Local\\Temp\\rslv-vectors\\file.md"],["?","C:\\Users\\34689\\AppData\\Local\\Temp\\rslv-vectors\\?"],["*","C:\\Users\\34689\\AppData\\Local\\Temp\\rslv-vectors\\*"],["/\\foo","C:\\foo"],["\\/foo","C:\\foo"],["\\foo","C:\\foo"],["/foo/bar","C:\\foo\\bar"],["D:\\Notes\\ReadMe.MD","D:\\Notes\\ReadMe.MD"],["中文\\目录","C:\\Users\\34689\\AppData\\Local\\Temp\\rslv-vectors\\中文\\目录"],["D:\\a b\\c d","D:\\a b\\c d"]],"join":[[["C:\\base","Guanlan","workspaces","6d74a29df40616ec"],"C:\\base\\Guanlan\\workspaces\\6d74a29df40616ec"],[["C:/base","Guanlan","workspaces","6d74a29df40616ec"],"C:\\base\\Guanlan\\workspaces\\6d74a29df40616ec"],[["C:/base/","","Guanlan","6d74a29df40616ec"],"C:\\base\\Guanlan\\6d74a29df40616ec"],[["C:\\","sub","6d74a29df40616ec"],"C:\\sub\\6d74a29df40616ec"],[["C:\\base\\",""],"C:\\base\\"],[["base","x"],"base\\x"],[["","x"],"x"],[["",""],"."],[["\\\\srv\\share","a","b"],"\\\\srv\\share\\a\\b"],[["C:\\base","a\\b","c"],"C:\\base\\a\\b\\c"],[["C:/base","a/b","c"],"C:\\base\\a\\b\\c"],[["C:\\base",".",".."],"C:\\"]],"rootKey":[["D:\\notebooks\\demo","6d74a29df40616ec"],["D:\\notebooks\\demo\\","6d74a29df40616ec"],["d:/notebooks/demo","4c04a8aa7634d59c"],["D:\\观澜\\工作区","df515ae695087507"],["C:\\Users\\34689\\AppData\\Local\\Temp\\rslv-vectors","377d41a5d7ed5743"]],"fileId":[["6d74a29df40616ec","Notes\\ReadMe.MD","f_b967338b81904b60abf8374e"],["6d74a29df40616ec","notes/readme.md","f_b967338b81904b60abf8374e"],["6d74a29df40616ec","docs/方案.md","f_422b0386a77ef4e4f9eafd30"],["0123456789abcdef","a/b/c.svg","f_40700c3ee03f5b6c73d29880"]]}"#;

    #[test]
    fn session_measured_resolve_join_identity_vectors() {
        let vectors: serde_json::Value =
            serde_json::from_str(SESSION_VECTORS).expect("内嵌会话向量 JSON 损坏");
        let cwd = vectors["cwd"].as_str().expect("cwd").to_owned();
        for (input, expected) in vectors["resolve"]
            .as_array()
            .expect("resolve")
            .iter()
            .map(|p| {
                (
                    p[0].as_str().unwrap_or_default(),
                    p[1].as_str().unwrap_or_default(),
                )
            })
        {
            assert_eq!(
                path_win32::resolve_with(&[input], &cwd, &|_| None),
                expected,
                "resolve({input:?}) 与 node v24.19.0 实测不符"
            );
        }
        for pair in vectors["join"].as_array().expect("join") {
            let args: Vec<&str> = pair[0]
                .as_array()
                .expect("join args")
                .iter()
                .map(|a| a.as_str().unwrap_or_default())
                .collect();
            let expected = pair[1].as_str().expect("join expected");
            assert_eq!(
                path_win32::join_with(&args),
                expected,
                "join({args:?}) 与 node 实测不符"
            );
        }
        for triple in vectors["rootKey"].as_array().expect("rootKey") {
            let input = triple[0].as_str().unwrap_or_default();
            let expected = triple[1].as_str().unwrap_or_default();
            assert_eq!(
                root_key_of_resolved(&path_win32::resolve_with(&[input], &cwd, &|_| None)),
                expected,
                "rootKey({input:?}) 与 node 实测不符"
            );
        }
        for triple in vectors["fileId"].as_array().expect("fileId") {
            let root_key = triple[0].as_str().unwrap_or_default();
            let rel = triple[1].as_str().unwrap_or_default();
            let expected = triple[2].as_str().unwrap_or_default();
            assert_eq!(
                stable_file_id(root_key, rel),
                expected,
                "fileId({rel:?}) 与 node 实测不符"
            );
        }
    }
}
