use super::*;
#[test]
fn identity_vectors_from_fixture() {
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
