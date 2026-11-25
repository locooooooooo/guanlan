use super::*;
/// 夹具身份数字向量（native/testdata/identity-vectors.json，由
/// scripts/seed-fixture.ts 生成）。文件被 gitignore 且不在 git 内：
/// 干净 checkout（无 seed 的 CI cargo 作业）缺文件时**显式降级跳过**，
/// 不 panic，确保无 seed 的干净 checkout 也能通过 `cargo test`。
///
/// 夹具 JSON 结构（以 scripts/seed-fixture.ts 实际产出为准）：
/// ```jsonc
/// {
///   "node": { "cwd": "H:\\…" },            // 相对路径/纯盘符向量使用的进程 cwd
///   "root_key_cases": [                     // rootKey 断言（含 resolved/workspace_id）
///     { "input": "…", "resolved": "…", "root_key": "773818154cee7e6d",
///       "workspace_id": "ws_773818154cee7e6d", "note": "…" }
///   ],
///   "portable": [                           // 与 cwd 无关的 rootKey 断言（绝对路径）
///     { "input": "D:\\notebooks\\demo", "root_key": "6d74a29df40616ec" }
///   ],
///   "file_id_cases": [                      // file_id 断言（含归一化交叉自检列）
///     { "root_key": "fbf9781d0083e1ca", "input": "Notes\\ReadMe.MD",
///       "normalized_input": "notes/readme.md", "file_id": "f_…" }
///   ],
///   "fixture_files": [                      // 夹具工作区全量文件的 file_id 断言
///     { "relative_path": "assets/logo.svg", "file_id": "f_…" }
///   ]
/// }
/// ```
#[test]
fn identity_vectors_from_fixture() {
    // identity-vectors.json 被仓库根 .gitignore 忽略且由
    // seed-fixture.ts 生成——干净 checkout（无 seed 的 CI cargo 作业）没有该文件。
    // 缺文件时显式降级跳过而非 panic；身份公式本身由本文件的 SESSION_VECTORS
    // 内嵌向量与 contract_stated_identity_values 覆盖，不因夹具缺失而失守。
    let text = match std::fs::read_to_string(IDENTITY_VECTORS_PATH) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            note_skipped(format!(
                "身份数字向量夹具 {} 不存在（干净 checkout 无 seed），\
                     跳过夹具向量断言；生成方式：node node_modules/tsx/dist/cli.mjs \
                     scripts/seed-fixture.ts（io: {e}）",
                IDENTITY_VECTORS_PATH
            ));
            return;
        }
        Err(e) => panic!("读取身份数字向量夹具失败 {IDENTITY_VECTORS_PATH}: {e}"),
    };
    let vectors: serde_json::Value =
        serde_json::from_str(&text).expect("identity-vectors.json 不是合法 JSON");
    let node_cwd = vectors
        .get("node")
        .and_then(|n| n.get("cwd"))
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_owned();

    let mut checked = 0usize;

    // root_key_cases：resolve → rootKey → workspace_id 全链断言
    let mut candidate_root_keys: Vec<String> = Vec::new();
    if let Some(list) = vectors.get("root_key_cases").and_then(|v| v.as_array()) {
        for case in list {
            let input = case.get("input").and_then(|x| x.as_str()).expect("input");
            let resolved = path_win32::resolve_with(&[input], &node_cwd, &|_| None);
            if let Some(expected_resolved) = case.get("resolved").and_then(|x| x.as_str()) {
                assert_eq!(resolved, expected_resolved, "resolve({input:?}) 与夹具不符");
            }
            let expected = case
                .get("root_key")
                .and_then(|x| x.as_str())
                .expect("root_key");
            assert_eq!(
                root_key_of_resolved(&resolved),
                expected,
                "rootKey({input:?}) 与夹具不符"
            );
            if let Some(ws_id) = case.get("workspace_id").and_then(|x| x.as_str()) {
                assert_eq!(
                    workspace_id_of(expected),
                    ws_id,
                    "workspace_id({expected}) 与夹具不符"
                );
            }
            if !candidate_root_keys.contains(&expected.to_owned()) {
                candidate_root_keys.push(expected.to_owned());
            }
            checked += 1;
        }
    }

    // portable：绝对路径向量，与 cwd 无关
    if let Some(list) = vectors.get("portable").and_then(|v| v.as_array()) {
        for case in list {
            let input = case.get("input").and_then(|x| x.as_str()).expect("input");
            let expected = case
                .get("root_key")
                .and_then(|x| x.as_str())
                .expect("root_key");
            assert_eq!(
                root_key_of_resolved(&path_win32::resolve_with(&[input], &node_cwd, &|_| None)),
                expected,
                "rootKey({input:?}) 与夹具 portable 段不符"
            );
            checked += 1;
        }
    }

    // file_id_cases：normalize+lower 交叉自检列 + file_id 断言
    if let Some(list) = vectors.get("file_id_cases").and_then(|v| v.as_array()) {
        for case in list {
            let root_key = case
                .get("root_key")
                .and_then(|x| x.as_str())
                .expect("root_key");
            let input = case.get("input").and_then(|x| x.as_str()).expect("input");
            if let Some(normalized) = case.get("normalized_input").and_then(|x| x.as_str()) {
                assert_eq!(
                    normalize_rel_path(input).to_lowercase(),
                    normalized,
                    "normalizeRelPath+toLowerCase({input:?}) 与夹具交叉列不符"
                );
            }
            let expected = case
                .get("file_id")
                .and_then(|x| x.as_str())
                .expect("file_id");
            assert_eq!(
                stable_file_id(root_key, input),
                expected,
                "fileId({input:?}) 与夹具不符"
            );
            checked += 1;
        }
    }

    // fixture_files：夹具工作区全量文件清单，与 root_key_cases 中提供的
    // 工作区根配对（生成口径：全部 58 个文件与同一 root_key 匹配）
    if let Some(list) = vectors.get("fixture_files").and_then(|v| v.as_array()) {
        if !list.is_empty() && !candidate_root_keys.is_empty() {
            let mut best = 0usize;
            for rk in &candidate_root_keys {
                let hits = list
                    .iter()
                    .filter(|f| {
                        let rel = f
                            .get("relative_path")
                            .and_then(|x| x.as_str())
                            .unwrap_or_default();
                        let expected = f
                            .get("file_id")
                            .and_then(|x| x.as_str())
                            .unwrap_or_default();
                        stable_file_id(rk, rel) == expected
                    })
                    .count();
                best = best.max(hits);
            }
            assert_eq!(
                best,
                list.len(),
                "fixture_files 的 {best}/{} 个 file_id 与 root_key_cases 提供的任一工作区根匹配",
                list.len()
            );
            checked += list.len();
        }
    }

    assert!(
        checked > 0,
        "identity-vectors.json 未包含任何向量（root_key_cases / file_id_cases）"
    );
}
