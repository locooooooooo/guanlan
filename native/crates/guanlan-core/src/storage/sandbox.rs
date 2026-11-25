//! 工作区权限沙箱与路径逃逸防御（审计护栏）。
//!
//! 停机红线：任一 MCP 工具、HTTP 端点或后台写回操作，均**严禁**读取或写入授权工作区目录之外的
//! 任意文件（包括 `..` 父目录穿越、绝对路径/盘符/UNC、URL 编码逃逸、空字节/控制字符、NTFS 备用
//! 数据流冒号、Windows 保留设备名、以及指向工作区外部的符号链接/目录联接）。

use std::fs;
use std::path::{Component, Path, PathBuf};

use serde::Serialize;

use crate::application::context::is_sensitive_secret_path;
use crate::error::GuanlanError;
use crate::storage::{internal_sql, ReadonlyStore};

/// 工作区路径沙箱审计结果（供 `GET /api/v1/audit/ledger` 与 `guanlan audit` 诊断命令复用）
#[derive(Debug, Clone, Serialize)]
pub struct SandboxAuditReport {
    pub ok: bool,
    pub checked_files: usize,
    pub violations: Vec<SandboxViolation>,
}

/// 单条沙箱路径违规记录
#[derive(Debug, Clone, Serialize)]
pub struct SandboxViolation {
    pub file_id: String,
    pub path: String,
    pub reason: String,
}

fn is_windows_reserved_stem(segment: &str) -> bool {
    let stem = segment.split('.').next().unwrap_or(segment);
    matches!(
        stem.to_ascii_uppercase().as_str(),
        "CON"
            | "PRN"
            | "AUX"
            | "NUL"
            | "COM1"
            | "COM2"
            | "COM3"
            | "COM4"
            | "COM5"
            | "COM6"
            | "COM7"
            | "COM8"
            | "COM9"
            | "LPT1"
            | "LPT2"
            | "LPT3"
            | "LPT4"
            | "LPT5"
            | "LPT6"
            | "LPT7"
            | "LPT8"
            | "LPT9"
    )
}

/// 剥离 Windows `canonicalize` 生成的 `\\?\` 逐字前缀，保持标准文件 API 兼容
fn strip_win_verbatim_prefix(path: &Path) -> PathBuf {
    #[cfg(windows)]
    {
        let raw = path.to_string_lossy();
        if let Some(rest) = raw.strip_prefix(r"\\?\UNC\") {
            return PathBuf::from(format!(r"\\{rest}"));
        }
        if let Some(rest) = raw.strip_prefix(r"\\?\") {
            return PathBuf::from(rest);
        }
    }
    path.to_path_buf()
}

/// 词法级工作区相对路径校验：剥离可选 `guanlan://` 前缀并拦截全部路径逃逸形态。
///
/// 返回规范化后的 `/` 分隔相对路径；任何逃逸/绝对/非法形态均返回 `BadRequest("PATH_ESCAPE_DENIED: ...")`。
pub fn validate_workspace_rel_path(raw: &str) -> Result<String, GuanlanError> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(GuanlanError::BadRequest(
            "PATH_ESCAPE_DENIED: 路径不能为空".to_owned(),
        ));
    }
    if trimmed.contains('\0') || trimmed.chars().any(|c| c.is_control()) {
        return Err(GuanlanError::BadRequest(
            "PATH_ESCAPE_DENIED: 路径包含空字节或控制字符".to_owned(),
        ));
    }
    let stripped = trimmed.strip_prefix("guanlan://").unwrap_or(trimmed).trim();
    if stripped.is_empty() {
        return Err(GuanlanError::BadRequest(
            "PATH_ESCAPE_DENIED: 剥离 guanlan:// 后路径为空".to_owned(),
        ));
    }
    // 拦截 URI scheme 注入（如 file:///etc/passwd）及 Windows 盘符/NTFS ADS 冒号
    if stripped.contains(':') {
        return Err(GuanlanError::BadRequest(format!(
            "PATH_ESCAPE_DENIED: 禁止包含盘符、协议头或冒号：{trimmed}"
        )));
    }
    // 拦截 URL 编码形式的路径逃逸（%2e / %2f / %5c / %00）
    let lower = stripped.to_ascii_lowercase();
    if lower.contains("%2e")
        || lower.contains("%2f")
        || lower.contains("%5c")
        || lower.contains("%00")
    {
        return Err(GuanlanError::BadRequest(format!(
            "PATH_ESCAPE_DENIED: 禁止包含编码型路径穿越序列：{trimmed}"
        )));
    }
    // 拦截 UNC / 根绝对路径（统一斜杠前先检反斜杠 UNC）
    if stripped.starts_with('/') || stripped.starts_with('\\') {
        return Err(GuanlanError::BadRequest(format!(
            "PATH_ESCAPE_DENIED: 禁止绝对路径或 UNC 网络路径：{trimmed}"
        )));
    }

    let normalized = stripped.replace('\\', "/");
    if normalized.starts_with('/') || normalized.ends_with('/') {
        return Err(GuanlanError::BadRequest(format!(
            "PATH_ESCAPE_DENIED: 路径不能以斜杠开头或结尾：{trimmed}"
        )));
    }
    let probe = Path::new(&normalized);
    if probe.is_absolute() {
        return Err(GuanlanError::BadRequest(format!(
            "PATH_ESCAPE_DENIED: 禁止绝对路径：{trimmed}"
        )));
    }
    for component in probe.components() {
        if !matches!(component, Component::Normal(_)) {
            return Err(GuanlanError::BadRequest(format!(
                "PATH_ESCAPE_DENIED: 路径包含非法穿越段：{trimmed}"
            )));
        }
    }

    let mut clean_segments = Vec::new();
    for seg in normalized.split('/') {
        if seg.is_empty() || seg == "." || seg == ".." {
            return Err(GuanlanError::BadRequest(format!(
                "PATH_ESCAPE_DENIED: 路径包含空段或相对穿越段（`.` / `..`）：{trimmed}"
            )));
        }
        if is_windows_reserved_stem(seg) {
            return Err(GuanlanError::BadRequest(format!(
                "PATH_ESCAPE_DENIED: 路径段命中系统保留设备名：{seg}"
            )));
        }
        clean_segments.push(seg);
    }

    Ok(clean_segments.join("/"))
}

/// MCP 外部代理路径校验：在工作区路径沙箱之上叠加敏感凭据路径拦截（`.env` / `*.pem` / `id_rsa` 等）。
pub fn validate_mcp_rel_path(raw: &str) -> Result<String, GuanlanError> {
    let clean = validate_workspace_rel_path(raw)?;
    if is_sensitive_secret_path(&clean) {
        return Err(GuanlanError::BadRequest(format!(
            "SECRET_PATH_DENIED: 拒绝通过 MCP 访问敏感凭据/环境变量文件：{clean}"
        )));
    }
    Ok(clean)
}

/// 目录前缀词法校验（用于 `search_workspace.path_prefix`）：允许空字符串表示全库，非空须通过沙箱校验。
pub fn validate_mcp_dir_prefix(raw: &str) -> Result<String, GuanlanError> {
    let trimmed = raw.trim().trim_end_matches(['/', '\\']);
    if trimmed.is_empty() {
        return Ok(String::new());
    }
    validate_mcp_rel_path(trimmed)
}

/// 真实文件系统越狱防护：逐段遍历并校验每一段既不是符号链接、规范化后又严格落在 `base_dir` 内部。
///
/// 适用场景：`apply_decision_writeback`、`execute_propose`、`execute_adopt`、草案磁盘比对及数据目录快照读取。
pub fn resolve_existing_file_in_dir_jail(
    base_dir: &Path,
    rel_path: &str,
) -> Result<PathBuf, GuanlanError> {
    let clean = validate_workspace_rel_path(rel_path)?;
    if !base_dir.is_dir() {
        return Err(GuanlanError::NotFound(format!(
            "授权根目录不存在：{}",
            base_dir.display()
        )));
    }
    let canon_root = fs::canonicalize(base_dir).map_err(|e| {
        GuanlanError::Internal(format!("规范化授权根目录失败 {}：{e}", base_dir.display()))
    })?;

    let mut cur = canon_root.clone();
    for seg in clean.split('/') {
        cur.push(seg);
        let meta = fs::symlink_metadata(&cur).map_err(|e| {
            GuanlanError::NotFound(format!("磁盘文件不存在或不可访问：{clean} ({e})"))
        })?;
        if meta.file_type().is_symlink() {
            return Err(GuanlanError::BadRequest(format!(
                "PATH_ESCAPE_DENIED: 拒绝穿越符号链接路径：{clean}"
            )));
        }
        let canon_step = fs::canonicalize(&cur)
            .map_err(|e| GuanlanError::NotFound(format!("规范化路径失败：{clean} ({e})")))?;
        if !canon_step.starts_with(&canon_root) {
            return Err(GuanlanError::BadRequest(format!(
                "PATH_ESCAPE_DENIED: 路径解析后越出授权工作区边界：{clean}"
            )));
        }
    }

    let final_meta = fs::symlink_metadata(&cur)
        .map_err(|e| GuanlanError::NotFound(format!("磁盘文件不存在：{clean} ({e})")))?;
    if !final_meta.is_file() {
        return Err(GuanlanError::BadRequest(format!(
            "PATH_ESCAPE_DENIED: 目标不是常规文件：{clean}"
        )));
    }
    Ok(strip_win_verbatim_prefix(&cur))
}

/// 工作区根字符串便捷封装
pub fn resolve_workspace_file_in_jail(
    root_path: &str,
    rel_path: &str,
) -> Result<PathBuf, GuanlanError> {
    resolve_existing_file_in_dir_jail(Path::new(root_path), rel_path)
}

/// 审计索引库内全部活跃 `files.current_path` 是否严格处于工作区沙箱边界内（只读检查，零副作用）
pub fn audit_workspace_file_paths(
    store: &ReadonlyStore,
) -> Result<SandboxAuditReport, GuanlanError> {
    let ws = store.workspace()?;
    let rows: Vec<(String, String, String)> = store.read_txn(|conn| {
        let mut stmt = conn
            .prepare(
                "SELECT file_id, current_path, status
                 FROM files
                 WHERE workspace_id = ?
                 ORDER BY file_id ASC",
            )
            .map_err(internal_sql)?;
        let iter = stmt
            .query_map([&ws.workspace_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })
            .map_err(internal_sql)?;
        let mut out = Vec::new();
        for item in iter {
            out.push(item.map_err(internal_sql)?);
        }
        Ok(out)
    })?;

    let root = Path::new(&ws.root_path);
    let mut violations = Vec::new();
    for (file_id, path, status) in &rows {
        if let Err(err) = validate_workspace_rel_path(path) {
            violations.push(SandboxViolation {
                file_id: file_id.clone(),
                path: path.clone(),
                reason: err.to_string(),
            });
            continue;
        }
        if status == "active" {
            match resolve_existing_file_in_dir_jail(root, path) {
                Ok(_) => {}
                // 磁盘临时缺失不算越界（交由 reconcile 标 missing）；仅拦截真实越界/符号链接
                Err(GuanlanError::NotFound(_)) => {}
                Err(err) => {
                    violations.push(SandboxViolation {
                        file_id: file_id.clone(),
                        path: path.clone(),
                        reason: err.to_string(),
                    });
                }
            }
        }
    }

    Ok(SandboxAuditReport {
        ok: violations.is_empty(),
        checked_files: rows.len(),
        violations,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_all_common_path_escape_and_secret_vectors() {
        let escape_cases = [
            "",
            "   ",
            "../outside.md",
            "docs/../../outside.md",
            "guanlan://../outside.md",
            "/etc/passwd",
            r"\Windows\win.ini",
            r"\\evil-server\share\secret.md",
            r"C:\Windows\System32\drivers\etc\hosts",
            "file:///C:/Users/secret.txt",
            "docs/plan.md:Zone.Identifier",
            "docs/%2e%2e/outside.md",
            "docs/%2E%2E%2Foutside.md",
            "docs/a\0b.md",
            "docs/CON.md",
            "docs/./plan.md",
            "docs//plan.md",
            "docs/plan.md/",
        ];
        for case in escape_cases {
            let err =
                validate_workspace_rel_path(case).expect_err(&format!("应拦截逃逸路径: {case}"));
            assert!(
                err.to_string().contains("PATH_ESCAPE_DENIED"),
                "错误应含 PATH_ESCAPE_DENIED ({case}): {err}"
            );
        }

        // 合法工作区路径放行
        assert_eq!(
            validate_workspace_rel_path(r"guanlan://01-专项\方案.md").unwrap(),
            "01-专项/方案.md"
        );

        // MCP 额外拦截敏感凭据路径
        for secret in [
            ".env",
            "config/.env.local",
            "keys/id_rsa",
            "certs/server.pem",
        ] {
            let err =
                validate_mcp_rel_path(secret).expect_err(&format!("MCP 应拦截敏感文件: {secret}"));
            assert!(
                err.to_string().contains("SECRET_PATH_DENIED"),
                "错误应含 SECRET_PATH_DENIED ({secret}): {err}"
            );
        }
    }

    #[test]
    fn jail_allows_normal_file_and_rejects_escape_outside_root() {
        let dir = std::env::temp_dir().join(format!(
            "guanlan-sandbox-test-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let ws_root = dir.join("workspace");
        let outside = dir.join("outside.txt");
        fs::create_dir_all(ws_root.join("docs")).unwrap();
        fs::write(ws_root.join("docs/plan.md"), "# ok").unwrap();
        fs::write(&outside, "TOP_SECRET_OUTSIDE").unwrap();

        let ok_path = resolve_existing_file_in_dir_jail(&ws_root, "docs/plan.md").unwrap();
        assert!(ok_path.ends_with("plan.md"));

        assert!(resolve_existing_file_in_dir_jail(&ws_root, "../outside.txt").is_err());

        // 若当前环境具备创建符号链接权限，同步验证逃逸符号链接被阻断
        let link_path = ws_root.join("docs/escape-link.md");
        #[cfg(windows)]
        let symlink_res = std::os::windows::fs::symlink_file(&outside, &link_path);
        #[cfg(unix)]
        let symlink_res = std::os::unix::fs::symlink(&outside, &link_path);
        if symlink_res.is_ok() {
            let err = resolve_existing_file_in_dir_jail(&ws_root, "docs/escape-link.md")
                .expect_err("指向工作区外部的符号链接必须被沙箱拒绝");
            assert!(err.to_string().contains("PATH_ESCAPE_DENIED"));
        }

        let _ = fs::remove_dir_all(&dir);
    }
}
