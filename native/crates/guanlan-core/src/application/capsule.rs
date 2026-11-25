//! 事项资料胶囊（Context Capsule）与离线阅读包导出。
//!
//! 设计与停机红线：
//! 1. **两阶段强制预览门禁（Fail-Closed）**：
//!    - 阶段一 `preview_capsule`（只读零副作用）：清点候选文件、估算总字节、执行路径/内容敏感扫描、
//!      自动取消勾选全部敏感目录/凭据文件，并生成绑定本次选中集合与脱敏参数的 `preview_token`；
//!    - 阶段二 `export_capsule`：必须提供匹配当前状态的 `preview_token` 且 `confirmed_preview = true`，
//!      未预览或参数漂移即以 `PREVIEW_REQUIRED` 拒绝，绝不允许未预览静默打包未勾选敏感目录！
//! 2. **双形态输出与双受众可读**：
//!    - 支持 `with_snapshots`（带选定版本去重快照原文副本）与 `manifest_only`（仅带引用清单与脉络）；
//!    - 产出开放目录包：`TIMELINE.md`（按时间演进脉络可读）、`DECISIONS.md`（决定与原文行号证据索引表）、
//!      `index.html`（零外部依赖离线浏览器单页阅读器，含检索与时间主干）、`capsule-manifest.json`
//!      （`guanlan.capsule.v1` 开放契约，供另一台观澜通过 `inspect_capsule_dir` 秒开还原完整主干与证据跳转）
//!      及 `files/<relative_path>`（仅 `with_snapshots` 模式且快照可用时落盘，绝不拿磁盘现态冒充缺失快照）。
//! 3. **时间口径与诚实脱敏**：
//!    - 严格保留 `occurred_at`（业务发生）与 `observed_at`（系统采集）双字段不混写；
//!    - 文本快照在 `sanitize_secrets = true`（默认开启）时走 `sanitize_context_text` 确定性脱敏并如实计数。

use std::collections::{BTreeSet, HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

use rusqlite::params;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::application::context::{is_sensitive_secret_path, sanitize_context_text};
use crate::error::GuanlanError;
use crate::storage::sandbox::validate_workspace_rel_path;
use crate::storage::{internal_sql, ReadonlyStore};

/// 开放胶囊清单协议版本
pub const CAPSULE_SCHEMA_VERSION: &str = "guanlan.capsule.v1";

/// 胶囊导出模式：带快照原文 / 仅带引用清单
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum CapsuleMode {
    #[default]
    WithSnapshots,
    ManifestOnly,
}

impl CapsuleMode {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::WithSnapshots => "with_snapshots",
            Self::ManifestOnly => "manifest_only",
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "with_snapshots" | "snapshots" | "full" => Some(Self::WithSnapshots),
            "manifest_only" | "manifest" | "references_only" => Some(Self::ManifestOnly),
            _ => None,
        }
    }
}

fn default_true() -> bool {
    true
}

/// 预览请求（阶段一：零副作用）
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct CapsulePreviewRequest {
    /// 指定事项 ID（为空时结合 file_ids 或时间范围选取）
    #[serde(default)]
    pub initiative_id: Option<String>,
    /// 显式候选文件 ID 范围（缺省按 initiative_id 或全工作区时间窗口推导）
    #[serde(default)]
    pub file_ids: Vec<String>,
    /// 可选时间窗起点（YYYY-MM-DD 或 ISO-8601）
    #[serde(default)]
    pub from: Option<String>,
    /// 可选时间窗终点（YYYY-MM-DD 或 ISO-8601）
    #[serde(default)]
    pub to: Option<String>,
    /// 打包模式：带快照原文 / 仅带引用清单
    #[serde(default)]
    pub mode: CapsuleMode,
    /// 是否对文本快照自动执行密钥/环境变量脱敏（默认 true）
    #[serde(default = "default_true")]
    pub sanitize_secrets: bool,
    /// 用户取消勾选排除的目录前缀列表
    #[serde(default)]
    pub excluded_dirs: Vec<String>,
    /// 用户在预览面板显式勾选的最终文件 ID 子集（None = 按默认安全策略自动勾选全部非敏感非排除项）
    #[serde(default)]
    pub selected_file_ids: Option<Vec<String>>,
}

/// 导出请求（阶段二：必须携带与预览一致的 `preview_token` 且 `confirmed_preview = true`）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CapsuleExportRequest {
    #[serde(flatten)]
    pub preview: CapsulePreviewRequest,
    /// 阶段一预览返回的确认令牌（缺失或参数变动后失配即拒收）
    #[serde(default)]
    pub preview_token: String,
    /// 必须显式为 true，禁止未预览静默打包
    #[serde(default)]
    pub confirmed_preview: bool,
    /// 可选自定义输出目录（缺省写至 `<data_dir>/capsules/<slug>-<ts>`）
    #[serde(default)]
    pub output_dir: Option<String>,
}

/// 预览阶段单文件明细
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CapsuleFilePreview {
    pub file_id: String,
    pub relative_path: String,
    pub dir_path: String,
    pub title: String,
    pub format: String,
    pub revision_id: Option<String>,
    pub seq: i64,
    pub content_hash: String,
    pub size_bytes: u64,
    pub snapshot_available: bool,
    pub selected: bool,
    pub sensitive_path: bool,
    pub sensitive_reason: Option<String>,
    pub inline_secret_hits: usize,
}

/// 预览响应（含体积估算、脱敏告警与强制确认令牌）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CapsulePreviewResponse {
    pub ok: bool,
    pub preview_token: String,
    pub mode: CapsuleMode,
    pub sanitize_secrets: bool,
    pub title: String,
    pub initiative_id: Option<String>,
    pub from: Option<String>,
    pub to: Option<String>,
    pub selected_file_count: usize,
    pub total_candidate_count: usize,
    pub event_count: usize,
    pub decision_count: usize,
    pub relation_count: usize,
    pub estimated_total_bytes: u64,
    pub snapshot_bytes: u64,
    pub metadata_bytes: u64,
    pub sensitive_excluded_count: usize,
    pub inline_redaction_count: usize,
    pub sensitive_warnings: Vec<String>,
    pub dirs: Vec<String>,
    pub files: Vec<CapsuleFilePreview>,
}

/// 胶囊清单内的专项信息
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CapsuleManifestInitiative {
    pub initiative_id: String,
    pub name: String,
    pub dir_path: String,
    pub state: String,
}

/// 胶囊清单内的文件条目（供另一台观澜秒开还原身份与版本）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CapsuleManifestFile {
    pub file_id: String,
    pub relative_path: String,
    pub title: String,
    pub format: String,
    pub revision_id: Option<String>,
    pub seq: i64,
    pub content_hash: String,
    pub size_bytes: u64,
    pub snapshot_available: bool,
    /// `with_snapshots` 模式下在包内的相对路径，如 `files/01-专项/方案.md`
    pub bundled_rel_path: Option<String>,
    /// 包内落盘文件的实际 SHA-256（脱敏后与原始 content_hash 可能不同，用于离线完整性校验）
    pub bundled_sha256: Option<String>,
    pub redactions_applied: usize,
}

/// 胶囊清单内的时间线事件（严格保留 occurred_at / observed_at 双口径）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CapsuleManifestEvent {
    pub event_id: String,
    pub kind: String,
    pub subject_kind: String,
    pub subject_id: String,
    pub revision_id: Option<String>,
    pub relative_path: Option<String>,
    pub occurred_at: Option<String>,
    pub occurred_precision: String,
    pub observed_at: String,
    pub headline: String,
    pub detail: String,
}

/// 胶囊清单内的决定与原文行号证据
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CapsuleManifestDecision {
    pub statement_id: String,
    pub decision_id: Option<String>,
    pub file_id: String,
    pub relative_path: String,
    pub revision_id: String,
    pub code: String,
    pub status: String,
    pub question: String,
    pub quote: String,
    pub line_start: i64,
    pub line_end: i64,
    pub observed_at: String,
}

/// 胶囊清单内的引用/因果关系边
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CapsuleManifestRelation {
    pub edge_id: String,
    pub source_file_id: String,
    pub source_path: String,
    pub target_file_id: String,
    pub target_path: String,
    pub kind: String,
    pub locator_start: i64,
    pub locator_end: i64,
    pub reason: String,
}

/// `capsule-manifest.json` 开放协议顶层结构
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CapsuleManifest {
    pub schema_version: String,
    pub capsule_id: String,
    pub exported_at: String,
    pub mode: CapsuleMode,
    pub sanitized: bool,
    pub title: String,
    pub source_workspace_id: String,
    pub initiative: Option<CapsuleManifestInitiative>,
    pub from: Option<String>,
    pub to: Option<String>,
    pub files: Vec<CapsuleManifestFile>,
    pub events: Vec<CapsuleManifestEvent>,
    pub decisions: Vec<CapsuleManifestDecision>,
    pub relations: Vec<CapsuleManifestRelation>,
}

/// 导出完成回执
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CapsuleExportResponse {
    pub ok: bool,
    pub capsule_id: String,
    pub mode: CapsuleMode,
    pub output_dir: String,
    pub manifest_path: String,
    pub timeline_md_path: String,
    pub decisions_md_path: String,
    pub index_html_path: String,
    pub files_exported: usize,
    pub snapshots_written: usize,
    pub metadata_only_count: usize,
    pub event_count: usize,
    pub decision_count: usize,
    pub relation_count: usize,
    pub redactions_applied: usize,
    pub total_bytes: u64,
}

/// 另一台观澜秒开校验胶囊目录的结果
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CapsuleInspectResponse {
    pub ok: bool,
    pub capsule_dir: String,
    pub integrity_ok: bool,
    pub checked_snapshots: usize,
    pub integrity_issues: Vec<String>,
    pub manifest: CapsuleManifest,
}

/// 另一台观澜阅读胶囊内附带快照原文的响应（带沙箱越界防护与有界文本上限）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CapsuleFileContentResponse {
    pub ok: bool,
    pub bundled_rel_path: String,
    pub size_bytes: u64,
    pub truncated: bool,
    pub text: Option<String>,
}

/// 敏感路径/目录判定（在 `is_sensitive_secret_path` 基础上叠加常见敏感子目录防护）
pub fn is_sensitive_capsule_path(rel_path: &str) -> Option<&'static str> {
    if is_sensitive_secret_path(rel_path) {
        return Some("命中敏感凭据/环境变量文件名规则（.env / 私钥 / 凭据文件）");
    }
    let norm = rel_path.replace('\\', "/").to_ascii_lowercase();
    for seg in norm.split('/') {
        if matches!(
            seg,
            "secrets" | ".secrets" | "credentials" | ".gnupg" | ".kube" | "private-keys"
        ) {
            return Some("位于敏感凭据/私钥目录下，默认取消勾选禁止静默打包");
        }
    }
    None
}

fn dir_of(rel_path: &str) -> String {
    let norm = rel_path.replace('\\', "/");
    match norm.rsplit_once('/') {
        Some((dir, _)) => dir.to_owned(),
        None => "(根目录)".to_owned(),
    }
}

fn is_dir_excluded(rel_path: &str, excluded_dirs: &[String]) -> bool {
    if excluded_dirs.is_empty() {
        return false;
    }
    let norm = rel_path.replace('\\', "/").to_ascii_lowercase();
    let file_dir = dir_of(rel_path).to_ascii_lowercase();
    excluded_dirs.iter().any(|raw| {
        let ex = raw
            .trim()
            .replace('\\', "/")
            .trim_matches('/')
            .to_ascii_lowercase();
        if ex.is_empty() {
            return false;
        }
        if ex == "(根目录)" {
            return !norm.contains('/');
        }
        file_dir == ex
            || file_dir.starts_with(&format!("{ex}/"))
            || norm.starts_with(&format!("{ex}/"))
    })
}

fn is_text_sanitizable_format(format: &str) -> bool {
    matches!(
        format.to_ascii_lowercase().as_str(),
        "md" | "svg"
            | "text"
            | "code"
            | "table"
            | "data"
            | "json"
            | "yaml"
            | "toml"
            | "csv"
            | "tsv"
    )
}

fn sha256_hex_slice(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut out = String::with_capacity(64);
    for byte in digest {
        use std::fmt::Write as _;
        let _ = write!(&mut out, "{byte:02x}");
    }
    out
}

fn normalize_bound_start(raw: Option<&str>) -> Option<String> {
    let s = raw?.trim();
    if s.is_empty() {
        return None;
    }
    if s.len() == 10 && s.chars().nth(4) == Some('-') && s.chars().nth(7) == Some('-') {
        Some(format!("{s}T00:00:00Z"))
    } else {
        Some(s.to_owned())
    }
}

fn normalize_bound_end(raw: Option<&str>) -> Option<String> {
    let s = raw?.trim();
    if s.is_empty() {
        return None;
    }
    if s.len() == 10 && s.chars().nth(4) == Some('-') && s.chars().nth(7) == Some('-') {
        Some(format!("{s}T23:59:59.999Z"))
    } else {
        Some(s.to_owned())
    }
}

fn in_time_window(ts: &str, from: Option<&str>, to: Option<&str>) -> bool {
    if let Some(start) = from {
        if ts < start {
            return false;
        }
    }
    if let Some(end) = to {
        if ts > end {
            return false;
        }
    }
    true
}

fn compute_preview_token(
    workspace_id: &str,
    mode: CapsuleMode,
    sanitize_secrets: bool,
    from: Option<&str>,
    to: Option<&str>,
    selected_files: &[CapsuleFilePreview],
) -> String {
    let mut buf = String::new();
    buf.push_str("capsule_preview_v1|");
    buf.push_str(workspace_id);
    buf.push('|');
    buf.push_str(mode.as_str());
    buf.push('|');
    buf.push_str(if sanitize_secrets { "san1" } else { "san0" });
    buf.push('|');
    buf.push_str(from.unwrap_or(""));
    buf.push('|');
    buf.push_str(to.unwrap_or(""));
    let mut sorted: Vec<(&str, &str)> = selected_files
        .iter()
        .filter(|f| f.selected)
        .map(|f| (f.file_id.as_str(), f.content_hash.as_str()))
        .collect();
    sorted.sort_unstable();
    for (fid, hash) in sorted {
        buf.push('|');
        buf.push_str(fid);
        buf.push(':');
        buf.push_str(hash);
    }
    format!("cap_prev_{}", &sha256_hex_slice(buf.as_bytes())[..24])
}

#[derive(Debug)]
struct CapsuleBuildPlan {
    workspace_id: String,
    initiative: Option<CapsuleManifestInitiative>,
    title: String,
    preview: CapsulePreviewResponse,
    events: Vec<CapsuleManifestEvent>,
    decisions: Vec<CapsuleManifestDecision>,
    relations: Vec<CapsuleManifestRelation>,
}

fn build_capsule_plan(
    store: &ReadonlyStore,
    req: &CapsulePreviewRequest,
) -> Result<CapsuleBuildPlan, GuanlanError> {
    let ws = store.workspace()?;
    let from_bound = normalize_bound_start(req.from.as_deref());
    let to_bound = normalize_bound_end(req.to.as_deref());

    // 1. 收集专项元信息与候选文件集（单只读事务）
    let (initiative, raw_files) = store.read_txn(|conn| {
        let init: Option<CapsuleManifestInitiative> = if let Some(ref init_id) = req.initiative_id {
            match conn.query_row(
                "SELECT initiative_id, name, root_dir, state
                 FROM initiatives
                 WHERE workspace_id = ? AND initiative_id = ?",
                params![ws.workspace_id, init_id],
                |row| {
                    Ok(CapsuleManifestInitiative {
                        initiative_id: row.get(0)?,
                        name: row.get(1)?,
                        dir_path: row.get(2)?,
                        state: row.get(3)?,
                    })
                },
            ) {
                Ok(v) => Some(v),
                Err(rusqlite::Error::QueryReturnedNoRows) => None,
                Err(err) => return Err(internal_sql(err)),
            }
        } else {
            None
        };

        if req.initiative_id.is_some() && init.is_none() {
            return Err(GuanlanError::NotFound(format!(
                "未找到事项 {}",
                req.initiative_id.as_deref().unwrap_or("")
            )));
        }

        // 若给定了 initiative_id，优先按 artifact_states.initiative_id 与 dir_path 前缀收集文件
        let mut init_file_ids: HashSet<String> = HashSet::new();
        if let Some(ref iv) = init {
            let mut st = conn
                .prepare(
                    "SELECT file_id FROM artifact_states
                     WHERE workspace_id = ? AND initiative_id = ?",
                )
                .map_err(internal_sql)?;
            let rows = st
                .query_map(params![ws.workspace_id, iv.initiative_id], |r| {
                    r.get::<_, String>(0)
                })
                .map_err(internal_sql)?;
            for fid in rows {
                init_file_ids.insert(fid.map_err(internal_sql)?);
            }
        }

        let explicit_scope: HashSet<&str> = req.file_ids.iter().map(String::as_str).collect();

        let mut stmt = conn
            .prepare(
                "SELECT f.file_id, f.current_path, f.title, f.format, f.last_revision_id,
                        f.last_observed_at,
                        COALESCE(r.seq, 0), COALESCE(r.content_hash, ''),
                        COALESCE(r.size_bytes, 0), COALESCE(r.snapshot_available, 0)
                 FROM files f
                 LEFT JOIN revisions r ON r.revision_id = f.last_revision_id
                 WHERE f.workspace_id = ? AND f.status != 'missing'
                 ORDER BY f.current_path ASC",
            )
            .map_err(internal_sql)?;

        let mut rows_out = Vec::new();
        let iter = stmt
            .query_map([&ws.workspace_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, Option<String>>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, i64>(6)?,
                    row.get::<_, String>(7)?,
                    row.get::<_, i64>(8)?,
                    row.get::<_, i64>(9)?,
                ))
            })
            .map_err(internal_sql)?;

        for item in iter {
            let (
                file_id,
                rel_path,
                title,
                format,
                rev_id,
                last_obs,
                seq,
                content_hash,
                size_bytes,
                snap_avail,
            ) = item.map_err(internal_sql)?;
            let in_scope = if !explicit_scope.is_empty() {
                explicit_scope.contains(file_id.as_str())
            } else if let Some(ref iv) = init {
                let norm = rel_path.replace('\\', "/");
                let dir_prefix = iv.dir_path.trim_matches('/');
                init_file_ids.contains(&file_id)
                    || (!dir_prefix.is_empty()
                        && (norm == dir_prefix || norm.starts_with(&format!("{dir_prefix}/"))))
            } else {
                true
            };
            if !in_scope {
                continue;
            }
            if !in_time_window(&last_obs, from_bound.as_deref(), to_bound.as_deref()) {
                continue;
            }
            rows_out.push((
                file_id,
                rel_path,
                title,
                format,
                rev_id,
                seq,
                content_hash,
                size_bytes.max(0) as u64,
                snap_avail != 0,
            ));
        }

        Ok((init, rows_out))
    })?;

    // 2. 逐文件执行敏感路径扫描、体积测算与文本脱敏预检
    let explicit_selection: Option<HashSet<&str>> = req
        .selected_file_ids
        .as_ref()
        .map(|list| list.iter().map(String::as_str).collect());

    let mut dirs_set: BTreeSet<String> = BTreeSet::new();
    let mut file_previews: Vec<CapsuleFilePreview> = Vec::with_capacity(raw_files.len());
    let mut sensitive_warnings: Vec<String> = Vec::new();
    let mut sensitive_excluded_count: usize = 0;
    let mut inline_redaction_count: usize = 0;
    let mut snapshot_bytes: u64 = 0;

    for (file_id, rel_path, title, format, rev_id, seq, content_hash, size_bytes, snap_avail) in
        raw_files
    {
        let dir_path = dir_of(&rel_path);
        dirs_set.insert(dir_path.clone());
        let sensitive_reason = is_sensitive_capsule_path(&rel_path).map(str::to_owned);
        let sensitive_path = sensitive_reason.is_some();
        let excluded_by_dir = is_dir_excluded(&rel_path, &req.excluded_dirs);

        // 停机护栏：敏感路径永远默认不勾选；仅当用户在预览面板里显式放入 selected_file_ids 才允许勾选
        let selected = match &explicit_selection {
            Some(sel) => sel.contains(file_id.as_str()) && !excluded_by_dir,
            None => !sensitive_path && !excluded_by_dir,
        };

        if sensitive_path && !selected {
            sensitive_excluded_count += 1;
            sensitive_warnings.push(format!(
                "已自动排除敏感路径：{}（{}）",
                rel_path,
                sensitive_reason.as_deref().unwrap_or("敏感文件")
            ));
        } else if sensitive_path && selected {
            sensitive_warnings.push(format!(
                "注意：你已手动勾选敏感路径 {}，将在导出时执行密钥脱敏",
                rel_path
            ));
        }

        let mut actual_size = size_bytes;
        let mut inline_hits: usize = 0;
        if snap_avail && !content_hash.is_empty() {
            if let Ok(blob_path) = store.blob_path_for(&content_hash) {
                if let Ok(meta) = fs::metadata(&blob_path) {
                    actual_size = meta.len();
                }
                if selected
                    && req.mode == CapsuleMode::WithSnapshots
                    && req.sanitize_secrets
                    && is_text_sanitizable_format(&format)
                    && actual_size <= 4 * 1024 * 1024
                {
                    if let Ok(bytes) = fs::read(&blob_path) {
                        if let Ok(text) = std::str::from_utf8(&bytes) {
                            let (sanitized, hits) = sanitize_context_text(text);
                            inline_hits = hits;
                            actual_size = sanitized.len() as u64;
                        }
                    }
                }
            }
        }

        if selected {
            inline_redaction_count += inline_hits;
            if inline_hits > 0 {
                sensitive_warnings.push(format!(
                    "正文脱敏预检：{} 发现 {} 处密钥/凭据片段，导出时将自动替换为 [REDACTED_SECRET]",
                    rel_path, inline_hits
                ));
            }
            if req.mode == CapsuleMode::WithSnapshots && snap_avail {
                snapshot_bytes = snapshot_bytes.saturating_add(actual_size);
            }
        }

        file_previews.push(CapsuleFilePreview {
            file_id,
            relative_path: rel_path,
            dir_path,
            title,
            format,
            revision_id: rev_id,
            seq,
            content_hash,
            size_bytes: actual_size,
            snapshot_available: snap_avail,
            selected,
            sensitive_path,
            sensitive_reason,
            inline_secret_hits: inline_hits,
        });
    }

    let selected_ids: HashSet<String> = file_previews
        .iter()
        .filter(|f| f.selected)
        .map(|f| f.file_id.clone())
        .collect();
    let path_by_file_id: HashMap<String, String> = file_previews
        .iter()
        .map(|f| (f.file_id.clone(), f.relative_path.clone()))
        .collect();

    // 3. 查询选中文件集合对应的事件演进、决定证据与引用关系
    let (events, decisions, relations) = store.read_txn(|conn| {
        // 3.1 事件（按 occurred_at / observed_at 正序呈现演进脉络）
        let mut ev_stmt = conn
            .prepare(
                "SELECT event_id, kind, subject_kind, subject_id, revision_id,
                        occurred_at, occurred_precision, observed_at, headline, detail
                 FROM events
                 WHERE workspace_id = ?
                 ORDER BY COALESCE(occurred_at, observed_at) ASC, seq ASC",
            )
            .map_err(internal_sql)?;
        let mut events_out = Vec::new();
        let ev_iter = ev_stmt
            .query_map([&ws.workspace_id], |row| {
                Ok(CapsuleManifestEvent {
                    event_id: row.get(0)?,
                    kind: row.get(1)?,
                    subject_kind: row.get(2)?,
                    subject_id: row.get(3)?,
                    revision_id: row.get(4)?,
                    relative_path: None,
                    occurred_at: row.get(5)?,
                    occurred_precision: row.get(6)?,
                    observed_at: row.get(7)?,
                    headline: row.get(8)?,
                    detail: row.get(9)?,
                })
            })
            .map_err(internal_sql)?;
        for item in ev_iter {
            let mut ev = item.map_err(internal_sql)?;
            let ts = ev.occurred_at.as_deref().unwrap_or(&ev.observed_at);
            if !in_time_window(ts, from_bound.as_deref(), to_bound.as_deref()) {
                continue;
            }
            let related_file = if selected_ids.contains(&ev.subject_id) {
                Some(ev.subject_id.clone())
            } else if let Some(ref rev_id) = ev.revision_id {
                conn.query_row(
                    "SELECT file_id FROM revisions WHERE revision_id = ?",
                    [rev_id],
                    |r| r.get::<_, String>(0),
                )
                .ok()
                .filter(|fid| selected_ids.contains(fid))
            } else if let Some(ref iv) = initiative {
                if ev.subject_id == iv.initiative_id {
                    Some(String::new())
                } else {
                    None
                }
            } else {
                None
            };
            let Some(fid) = related_file else {
                continue;
            };
            if !fid.is_empty() {
                ev.relative_path = path_by_file_id.get(&fid).cloned();
            }
            if req.sanitize_secrets {
                let (h, _) = sanitize_context_text(&ev.headline);
                let (d, _) = sanitize_context_text(&ev.detail);
                ev.headline = h;
                ev.detail = d;
            }
            events_out.push(ev);
        }

        // 3.2 决定与原文行号证据（来自选中文件的最新版本陈述）
        let mut st_stmt = conn
            .prepare(
                "SELECT s.statement_id, s.decision_id, s.file_id, s.revision_id,
                        s.code, s.status, s.question, s.quote, s.line_start, s.line_end, s.observed_at
                 FROM statements s
                 JOIN files f ON f.file_id = s.file_id AND f.last_revision_id = s.revision_id
                 WHERE s.workspace_id = ?
                 ORDER BY f.current_path ASC, s.line_start ASC",
            )
            .map_err(internal_sql)?;
        let mut decisions_out = Vec::new();
        let st_iter = st_stmt
            .query_map([&ws.workspace_id], |row| {
                let fid: String = row.get(2)?;
                Ok((
                    fid,
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, String>(6)?,
                    row.get::<_, String>(7)?,
                    row.get::<_, i64>(8)?,
                    row.get::<_, i64>(9)?,
                    row.get::<_, String>(10)?,
                ))
            })
            .map_err(internal_sql)?;
        for item in st_iter {
            let (fid, sid, did, rev_id, code, status, question, quote, ls, le, obs) =
                item.map_err(internal_sql)?;
            if !selected_ids.contains(&fid) {
                continue;
            }
            let rel_path = path_by_file_id.get(&fid).cloned().unwrap_or_default();
            let (q_clean, quote_clean) = if req.sanitize_secrets {
                (
                    sanitize_context_text(&question).0,
                    sanitize_context_text(&quote).0,
                )
            } else {
                (question, quote)
            };
            decisions_out.push(CapsuleManifestDecision {
                statement_id: sid,
                decision_id: did,
                file_id: fid,
                relative_path: rel_path,
                revision_id: rev_id,
                code,
                status,
                question: q_clean,
                quote: quote_clean,
                line_start: ls,
                line_end: le,
                observed_at: obs,
            });
        }

        // 3.3 关系边（两端或源端在选中文件集内的引用与 derived_from_context 边）
        let mut ed_stmt = conn
            .prepare(
                "SELECT e.edge_id, e.source_file_id, e.target_file_id, e.kind,
                        e.locator_start, e.locator_end, e.reason,
                        sf.current_path, tf.current_path
                 FROM edges e
                 JOIN files sf ON sf.file_id = e.source_file_id AND sf.last_revision_id = e.source_revision_id
                 JOIN files tf ON tf.file_id = e.target_file_id
                 WHERE e.workspace_id = ?
                 ORDER BY sf.current_path ASC, e.locator_start ASC",
            )
            .map_err(internal_sql)?;
        let mut relations_out = Vec::new();
        let ed_iter = ed_stmt
            .query_map([&ws.workspace_id], |row| {
                Ok(CapsuleManifestRelation {
                    edge_id: row.get(0)?,
                    source_file_id: row.get(1)?,
                    target_file_id: row.get(2)?,
                    kind: row.get(3)?,
                    locator_start: row.get(4)?,
                    locator_end: row.get(5)?,
                    reason: row.get(6)?,
                    source_path: row.get(7)?,
                    target_path: row.get(8)?,
                })
            })
            .map_err(internal_sql)?;
        for item in ed_iter {
            let rel = item.map_err(internal_sql)?;
            if selected_ids.contains(&rel.source_file_id)
                && selected_ids.contains(&rel.target_file_id)
            {
                relations_out.push(rel);
            }
        }

        Ok((events_out, decisions_out, relations_out))
    })?;

    let title = initiative
        .as_ref()
        .map(|iv| iv.name.clone())
        .unwrap_or_else(|| {
            if let (Some(f), Some(t)) = (req.from.as_deref(), req.to.as_deref()) {
                format!("时间窗胶囊 {f} ~ {t}")
            } else {
                "工作区事项资料胶囊".to_owned()
            }
        });

    // 估算文档与清单元信息体积（TIMELINE.md + DECISIONS.md + index.html + capsule-manifest.json）
    let metadata_bytes = 6_144u64
        + (selected_ids.len() as u64) * 320
        + (events.len() as u64) * 360
        + (decisions.len() as u64) * 420
        + (relations.len() as u64) * 240;
    let estimated_total_bytes = snapshot_bytes.saturating_add(metadata_bytes);
    let preview_token = compute_preview_token(
        &ws.workspace_id,
        req.mode,
        req.sanitize_secrets,
        req.from.as_deref(),
        req.to.as_deref(),
        &file_previews,
    );

    let preview = CapsulePreviewResponse {
        ok: true,
        preview_token,
        mode: req.mode,
        sanitize_secrets: req.sanitize_secrets,
        title: title.clone(),
        initiative_id: initiative.as_ref().map(|i| i.initiative_id.clone()),
        from: req.from.clone(),
        to: req.to.clone(),
        selected_file_count: selected_ids.len(),
        total_candidate_count: file_previews.len(),
        event_count: events.len(),
        decision_count: decisions.len(),
        relation_count: relations.len(),
        estimated_total_bytes,
        snapshot_bytes,
        metadata_bytes,
        sensitive_excluded_count,
        inline_redaction_count,
        sensitive_warnings,
        dirs: dirs_set.into_iter().collect(),
        files: file_previews,
    };

    Ok(CapsuleBuildPlan {
        workspace_id: ws.workspace_id,
        initiative,
        title,
        preview,
        events,
        decisions,
        relations,
    })
}

/// 阶段一：预览事项资料胶囊（零写盘副作用）
pub fn preview_capsule(
    store: &ReadonlyStore,
    req: &CapsulePreviewRequest,
) -> Result<CapsulePreviewResponse, GuanlanError> {
    let plan = build_capsule_plan(store, req)?;
    Ok(plan.preview)
}

fn sanitize_slug(raw: &str) -> String {
    let mut out = String::new();
    for ch in raw.chars() {
        if ch.is_alphanumeric() || ch == '-' || ch == '_' || ('\u{4E00}'..='\u{9FFF}').contains(&ch)
        {
            out.push(ch);
        } else if !out.ends_with('-') {
            out.push('-');
        }
        if out.chars().count() >= 36 {
            break;
        }
    }
    let trimmed = out.trim_matches('-');
    if trimmed.is_empty() {
        "capsule".to_owned()
    } else {
        trimmed.to_owned()
    }
}

fn resolve_capsule_output_dir(
    store: &ReadonlyStore,
    title: &str,
    custom_output_dir: Option<&str>,
) -> Result<PathBuf, GuanlanError> {
    let ws = store.workspace()?;
    let ws_root_canon = fs::canonicalize(&ws.root_path).ok();
    let target = match custom_output_dir.map(str::trim).filter(|s| !s.is_empty()) {
        Some(custom) => {
            if custom.contains('\0') {
                return Err(GuanlanError::BadRequest(
                    "PATH_ESCAPE_DENIED: 输出目录包含空字节".to_owned(),
                ));
            }
            let p = PathBuf::from(custom);
            if p.components()
                .any(|c| matches!(c, std::path::Component::ParentDir))
            {
                return Err(GuanlanError::BadRequest(
                    "PATH_ESCAPE_DENIED: 输出目录不允许包含 .. 父目录穿越".to_owned(),
                ));
            }
            p
        }
        None => {
            let stamp = crate::index::clock::now_iso()
                .replace([':', '.'], "-")
                .replace('Z', "");
            store
                .data_dir()
                .join("capsules")
                .join(format!("{}-{stamp}", sanitize_slug(title)))
        }
    };

    if let Some(ref root_c) = ws_root_canon {
        if let Ok(target_c) = fs::canonicalize(&target) {
            if &target_c == root_c {
                return Err(GuanlanError::BadRequest(
                    "拒绝将胶囊直接覆盖输出到工作区根目录，请指定独立空目录".to_owned(),
                ));
            }
        }
    }
    Ok(target)
}

fn render_timeline_markdown(manifest: &CapsuleManifest) -> String {
    let mut md = String::new();
    md.push_str(&format!(
        "# {} · 事项演进脉络（TIMELINE）\n\n",
        manifest.title
    ));
    md.push_str(&format!(
        "> 导出时间：{} · 打包模式：{} · 脱敏保护：{} · 协议版本：`{}`\n\n",
        manifest.exported_at,
        if manifest.mode == CapsuleMode::WithSnapshots {
            "带快照原文"
        } else {
            "仅带引用清单"
        },
        if manifest.sanitized {
            "已开启"
        } else {
            "关闭"
        },
        manifest.schema_version
    ));
    if let Some(ref init) = manifest.initiative {
        md.push_str(&format!(
            "- **事项**：{}（`{}` · 状态 `{}` · 目录 `{}`）\n",
            init.name, init.initiative_id, init.state, init.dir_path
        ));
    }
    md.push_str(&format!(
        "- **规模**：{} 份文件 · {} 条事件 · {} 条决定证据 · {} 条关联边\n",
        manifest.files.len(),
        manifest.events.len(),
        manifest.decisions.len(),
        manifest.relations.len()
    ));
    md.push_str("- **离线浏览**：用任意浏览器打开本目录 `index.html`，或直接阅读 `DECISIONS.md` 与 `files/` 下原文副本。\n");
    md.push_str("- **观澜秒开**：在另一台观澜工作台打开本目录（识别 `capsule-manifest.json`）即可还原完整时间主干与证据跳转。\n\n");

    md.push_str("## 一、收录文件清单\n\n");
    md.push_str("| 文件路径 | 格式 | 版本 | SHA-256（前 12 位） | 附带快照 |\n");
    md.push_str("| :--- | :---: | :---: | :---: | :--- |\n");
    for f in &manifest.files {
        let short_hash = &f.content_hash[..12.min(f.content_hash.len())];
        let link = match &f.bundled_rel_path {
            Some(bp) => format!("[打开原件]({bp})"),
            None if manifest.mode == CapsuleMode::ManifestOnly => "仅引用清单".to_owned(),
            None => "仅记元数据（无快照）".to_owned(),
        };
        md.push_str(&format!(
            "| `{}` | `{}` | v{} | `{}` | {} |\n",
            f.relative_path, f.format, f.seq, short_hash, link
        ));
    }

    md.push_str("\n## 二、时间演进脉络（上旧下新按业务发生时间排序）\n\n");
    if manifest.events.is_empty() {
        md.push_str("_当前范围无已入轴事件。_\n\n");
    } else {
        let mut last_day = String::new();
        for ev in &manifest.events {
            let primary_ts = ev.occurred_at.as_deref().unwrap_or(&ev.observed_at);
            let day = primary_ts.get(..10).unwrap_or("未知日期");
            if day != last_day {
                md.push_str(&format!("### {day}\n\n"));
                last_day = day.to_owned();
            }
            let path_part = ev
                .relative_path
                .as_deref()
                .map(|p| format!(" · `{p}`"))
                .unwrap_or_default();
            md.push_str(&format!(
                "- **[{}]** {}（业务时间 `{}` / 采集时间 `{}`{}）\n",
                ev.kind,
                ev.headline,
                ev.occurred_at.as_deref().unwrap_or("—"),
                ev.observed_at,
                path_part
            ));
            if !ev.detail.trim().is_empty() {
                md.push_str(&format!("  - {}\n", ev.detail.trim().replace('\n', " ")));
            }
        }
        md.push('\n');
    }

    md.push_str("## 三、引用与因果关系\n\n");
    if manifest.relations.is_empty() {
        md.push_str("_当前范围暂无显式跨文件引用边。_\n");
    } else {
        for rel in &manifest.relations {
            md.push_str(&format!(
                "- `{}`（L{}-L{}） —[`{}`]→ `{}`：{}\n",
                rel.source_path,
                rel.locator_start,
                rel.locator_end,
                rel.kind,
                rel.target_path,
                rel.reason
            ));
        }
    }
    md
}

fn render_decisions_markdown(manifest: &CapsuleManifest) -> String {
    let mut md = String::new();
    md.push_str(&format!(
        "# {} · 决定与原文证据索引（DECISIONS）\n\n",
        manifest.title
    ));
    if manifest.decisions.is_empty() {
        md.push_str("_本胶囊范围内暂无已抽取的决定陈述。_\n");
        return md;
    }
    let bundled_by_id: HashMap<&str, &str> = manifest
        .files
        .iter()
        .filter_map(|f| Some((f.file_id.as_str(), f.bundled_rel_path.as_deref()?)))
        .collect();
    md.push_str("| 编号 | 状态 | 议题 | 原文证据锚点 | 原文摘录 |\n");
    md.push_str("| :---: | :---: | :--- | :--- | :--- |\n");
    for d in &manifest.decisions {
        let anchor = match bundled_by_id.get(d.file_id.as_str()) {
            Some(bp) => format!(
                "[`{}` L{}-L{}]({bp})",
                d.relative_path, d.line_start, d.line_end
            ),
            None => format!("`{}` L{}-L{}", d.relative_path, d.line_start, d.line_end),
        };
        let quote_one = d.quote.replace(['\r', '\n', '|'], " ");
        let question_one = d.question.replace(['\r', '\n', '|'], " ");
        md.push_str(&format!(
            "| `{}` | `{}` | {} | {} | {} |\n",
            d.code, d.status, question_one, anchor, quote_one
        ));
    }
    md
}

fn escape_html(raw: &str) -> String {
    raw.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

fn render_offline_index_html(manifest: &CapsuleManifest) -> String {
    let safe_title = escape_html(&manifest.title);
    let manifest_json = serde_json::to_string(manifest)
        .unwrap_or_else(|_| "{}".to_owned())
        .replace("</script>", "<\\/script>");
    format!(
        r#"<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>{safe_title} · 观澜事项资料胶囊</title>
  <style>
    :root {{ color-scheme: light dark; --bg:#0f1218; --card:#171c26; --fg:#e8ecf4; --muted:#9aa5b8; --accent:#7c6fd0; --ok:#3e9b6b; --warn:#d97757; --border:rgba(255,255,255,.1); }}
    @media (prefers-color-scheme: light) {{ :root {{ --bg:#f7f8fb; --card:#ffffff; --fg:#182030; --muted:#5c667a; --border:rgba(24,32,48,.1); }} }}
    body {{ margin:0; font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif; background:var(--bg); color:var(--fg); }}
    .wrap {{ max-width:1040px; margin:0 auto; padding:28px 20px 64px; }}
    .hero {{ background:var(--card); border:1px solid var(--border); border-radius:16px; padding:20px 24px; margin-bottom:20px; }}
    .hero h1 {{ margin:0 0 8px; font-size:22px; }}
    .meta {{ color:var(--muted); font-size:12px; display:flex; flex-wrap:wrap; gap:12px; }}
    .search {{ width:100%; box-sizing:border-box; margin-top:14px; padding:9px 12px; border-radius:10px; border:1px solid var(--border); background:var(--bg); color:var(--fg); font-size:13px; }}
    .grid {{ display:grid; grid-template-columns:1fr; gap:16px; }}
    section {{ background:var(--card); border:1px solid var(--border); border-radius:14px; padding:16px 20px; }}
    section h2 {{ margin:0 0 12px; font-size:15px; border-bottom:1px solid var(--border); padding-bottom:8px; }}
    .row {{ padding:10px 0; border-bottom:1px dashed var(--border); }}
    .row:last-child {{ border-bottom:none; }}
    .pill {{ display:inline-block; padding:1px 8px; border-radius:999px; font-size:11px; background:rgba(124,111,208,.18); color:var(--accent); margin-right:6px; }}
    .pill.ok {{ background:rgba(62,155,107,.18); color:var(--ok); }}
    .pill.warn {{ background:rgba(217,119,87,.18); color:var(--warn); }}
    a {{ color:var(--accent); text-decoration:none; }}
    a:hover {{ text-decoration:underline; }}
    code {{ font-family:ui-monospace,SFMono-Regular,Consolas,monospace; font-size:12px; }}
    .muted {{ color:var(--muted); font-size:12px; }}
  </style>
</head>
<body>
  <div class="wrap">
    <div class="hero">
      <h1>{safe_title} · 事项资料胶囊</h1>
      <div class="meta" id="meta"></div>
      <input id="q" class="search" type="search" placeholder="筛选事件、文件、决定或原文摘录（纯离线运行，无需联网或安装观澜）..." />
    </div>
    <div class="grid">
      <section><h2>一、时间演进脉络</h2><div id="events"></div></section>
      <section><h2>二、决定与原文证据索引</h2><div id="decisions"></div></section>
      <section><h2>三、收录文件与版本快照</h2><div id="files"></div></section>
      <section><h2>四、跨文件引用与因果关系</h2><div id="relations"></div></section>
    </div>
  </div>
  <script id="capsule-data" type="application/json">{manifest_json}</script>
  <script>
    const data = JSON.parse(document.getElementById('capsule-data').textContent);
    const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}}[c]));
    document.getElementById('meta').innerHTML = [
      '协议 ' + esc(data.schema_version),
      '导出时间 ' + esc(data.exported_at),
      '模式 ' + (data.mode === 'with_snapshots' ? '带快照原文' : '仅引用清单'),
      '文件 ' + data.files.length + ' 份',
      '事件 ' + data.events.length + ' 条',
      '决定 ' + data.decisions.length + ' 条'
    ].map(x => '<span>' + x + '</span>').join('');
    const fileMap = Object.fromEntries(data.files.map(f => [f.file_id, f]));
    function render(kw) {{
      const needle = (kw || '').trim().toLowerCase();
      const hit = (s) => !needle || String(s || '').toLowerCase().includes(needle);
      document.getElementById('events').innerHTML = data.events
        .filter(e => hit(e.headline) || hit(e.detail) || hit(e.relative_path) || hit(e.kind))
        .map(e => '<div class="row"><span class="pill">' + esc(e.kind) + '</span><strong>' + esc(e.headline) + '</strong><div class="muted">业务时间 ' + esc(e.occurred_at || '—') + ' · 采集时间 ' + esc(e.observed_at) + (e.relative_path ? ' · <code>' + esc(e.relative_path) + '</code>' : '') + '</div>' + (e.detail ? '<div>' + esc(e.detail) + '</div>' : '') + '</div>')
        .join('') || '<div class="muted">无匹配事件</div>';
      document.getElementById('decisions').innerHTML = data.decisions
        .filter(d => hit(d.code) || hit(d.question) || hit(d.quote) || hit(d.relative_path))
        .map(d => {{
          const f = fileMap[d.file_id];
          const link = f && f.bundled_rel_path ? '<a href="' + esc(f.bundled_rel_path) + '">' + esc(d.relative_path) + ' L' + d.line_start + '-L' + d.line_end + '</a>' : '<code>' + esc(d.relative_path) + ' L' + d.line_start + '-L' + d.line_end + '</code>';
          return '<div class="row"><span class="pill ' + (d.status === 'confirmed' ? 'ok' : 'warn') + '">' + esc(d.status) + '</span><code>' + esc(d.code) + '</code> <strong>' + esc(d.question) + '</strong><div class="muted">证据：' + link + '</div><div>' + esc(d.quote) + '</div></div>';
        }}).join('') || '<div class="muted">无匹配决定</div>';
      document.getElementById('files').innerHTML = data.files
        .filter(f => hit(f.relative_path) || hit(f.title) || hit(f.format))
        .map(f => '<div class="row">' + (f.bundled_rel_path ? '<a href="' + esc(f.bundled_rel_path) + '"><strong>' + esc(f.relative_path) + '</strong></a>' : '<strong>' + esc(f.relative_path) + '</strong>') + ' <span class="pill">' + esc(f.format) + '</span> <span class="muted">v' + f.seq + ' · ' + esc(f.content_hash.slice(0, 12)) + ' · ' + (f.bundled_rel_path ? '已附原件' : (data.mode === 'manifest_only' ? '仅引用清单' : '仅记元数据')) + '</span></div>')
        .join('') || '<div class="muted">无匹配文件</div>';
      document.getElementById('relations').innerHTML = data.relations
        .filter(r => hit(r.source_path) || hit(r.target_path) || hit(r.reason))
        .map(r => '<div class="row"><code>' + esc(r.source_path) + '</code> (L' + r.locator_start + ') <span class="pill">' + esc(r.kind) + '</span> <code>' + esc(r.target_path) + '</code> <span class="muted">' + esc(r.reason) + '</span></div>')
        .join('') || '<div class="muted">无匹配关系</div>';
    }}
    render('');
    document.getElementById('q').addEventListener('input', (e) => render(e.target.value));
  </script>
</body>
</html>
"#
    )
}

/// 阶段二：执行导出事项资料胶囊至开放目录（强制校验 preview_token + confirmed_preview，停机红线 fail-closed）
pub fn export_capsule(
    store: &ReadonlyStore,
    req: &CapsuleExportRequest,
) -> Result<CapsuleExportResponse, GuanlanError> {
    if !req.confirmed_preview || req.preview_token.trim().is_empty() {
        return Err(GuanlanError::BadRequest(
            "PREVIEW_REQUIRED: 导出事项资料胶囊前必须先完成预览并显式确认（confirmed_preview=true 且提供 preview_token），严禁静默打包".to_owned(),
        ));
    }

    let plan = build_capsule_plan(store, &req.preview)?;
    if plan.preview.preview_token != req.preview_token.trim() {
        return Err(GuanlanError::BadRequest(format!(
            "PREVIEW_REQUIRED: 预览令牌已过期或参数已变更（期望 {}，收到 {}），请重新预览确认体积与脱敏清单后再导出",
            plan.preview.preview_token,
            req.preview_token.trim()
        )));
    }
    if plan.preview.selected_file_count == 0 {
        return Err(GuanlanError::BadRequest(
            "当前预览清单未勾选任何文件，请至少勾选 1 份文件后再打包".to_owned(),
        ));
    }

    let output_dir = resolve_capsule_output_dir(store, &plan.title, req.output_dir.as_deref())?;
    fs::create_dir_all(&output_dir).map_err(|e| {
        GuanlanError::Internal(format!(
            "创建胶囊输出目录失败 {}：{e}",
            output_dir.display()
        ))
    })?;

    let mut manifest_files: Vec<CapsuleManifestFile> = Vec::new();
    let mut snapshots_written: usize = 0;
    let mut metadata_only_count: usize = 0;
    let mut total_redactions: usize = 0;
    let mut total_bytes: u64 = 0;

    for f in plan.preview.files.iter().filter(|f| f.selected) {
        let mut bundled_rel_path: Option<String> = None;
        let mut bundled_sha256: Option<String> = None;
        let mut redactions: usize = 0;

        if req.preview.mode == CapsuleMode::WithSnapshots {
            if f.snapshot_available && !f.content_hash.is_empty() {
                if let Ok(blob_path) = store.blob_path_for(&f.content_hash) {
                    if let Ok(raw_bytes) = fs::read(&blob_path) {
                        let clean_rel = validate_workspace_rel_path(&f.relative_path)?;
                        let out_bytes = if req.preview.sanitize_secrets
                            && is_text_sanitizable_format(&f.format)
                        {
                            match std::str::from_utf8(&raw_bytes) {
                                Ok(text) => {
                                    let (san, hits) = sanitize_context_text(text);
                                    redactions = hits;
                                    san.into_bytes()
                                }
                                Err(_) => raw_bytes,
                            }
                        } else {
                            raw_bytes
                        };
                        let dest_rel = format!("files/{clean_rel}");
                        let dest_abs = output_dir.join(&dest_rel);
                        if let Some(parent) = dest_abs.parent() {
                            fs::create_dir_all(parent).map_err(|e| {
                                GuanlanError::Internal(format!(
                                    "创建胶囊子目录失败 {}：{e}",
                                    parent.display()
                                ))
                            })?;
                        }
                        fs::write(&dest_abs, &out_bytes).map_err(|e| {
                            GuanlanError::Internal(format!(
                                "写入胶囊文件失败 {}：{e}",
                                dest_abs.display()
                            ))
                        })?;
                        bundled_sha256 = Some(sha256_hex_slice(&out_bytes));
                        bundled_rel_path = Some(dest_rel);
                        snapshots_written += 1;
                        total_redactions += redactions;
                        total_bytes = total_bytes.saturating_add(out_bytes.len() as u64);
                    } else {
                        metadata_only_count += 1;
                    }
                } else {
                    metadata_only_count += 1;
                }
            } else {
                metadata_only_count += 1;
            }
        } else {
            metadata_only_count += 1;
        }

        manifest_files.push(CapsuleManifestFile {
            file_id: f.file_id.clone(),
            relative_path: f.relative_path.clone(),
            title: f.title.clone(),
            format: f.format.clone(),
            revision_id: f.revision_id.clone(),
            seq: f.seq,
            content_hash: f.content_hash.clone(),
            size_bytes: f.size_bytes,
            snapshot_available: f.snapshot_available,
            bundled_rel_path,
            bundled_sha256,
            redactions_applied: redactions,
        });
    }

    let exported_at = crate::index::clock::now_iso();
    let capsule_id = format!(
        "cap_{}",
        &sha256_hex_slice(
            format!(
                "{}|{}|{}|{}",
                plan.workspace_id,
                plan.preview.preview_token,
                exported_at,
                manifest_files.len()
            )
            .as_bytes()
        )[..16]
    );

    let manifest = CapsuleManifest {
        schema_version: CAPSULE_SCHEMA_VERSION.to_owned(),
        capsule_id: capsule_id.clone(),
        exported_at,
        mode: req.preview.mode,
        sanitized: req.preview.sanitize_secrets,
        title: plan.title,
        source_workspace_id: plan.workspace_id,
        initiative: plan.initiative,
        from: req.preview.from.clone(),
        to: req.preview.to.clone(),
        files: manifest_files,
        events: plan.events,
        decisions: plan.decisions,
        relations: plan.relations,
    };

    let manifest_bytes = serde_json::to_vec_pretty(&manifest)
        .map_err(|e| GuanlanError::Internal(format!("序列化 capsule-manifest.json 失败：{e}")))?;
    let timeline_md = render_timeline_markdown(&manifest);
    let decisions_md = render_decisions_markdown(&manifest);
    let index_html = render_offline_index_html(&manifest);

    let manifest_path = output_dir.join("capsule-manifest.json");
    let timeline_md_path = output_dir.join("TIMELINE.md");
    let decisions_md_path = output_dir.join("DECISIONS.md");
    let index_html_path = output_dir.join("index.html");

    for (path, bytes) in [
        (&manifest_path, manifest_bytes.as_slice()),
        (&timeline_md_path, timeline_md.as_bytes()),
        (&decisions_md_path, decisions_md.as_bytes()),
        (&index_html_path, index_html.as_bytes()),
    ] {
        fs::write(path, bytes).map_err(|e| {
            GuanlanError::Internal(format!("写入胶囊文件失败 {}：{e}", path.display()))
        })?;
        total_bytes = total_bytes.saturating_add(bytes.len() as u64);
    }

    Ok(CapsuleExportResponse {
        ok: true,
        capsule_id,
        mode: req.preview.mode,
        output_dir: output_dir.to_string_lossy().into_owned(),
        manifest_path: manifest_path.to_string_lossy().into_owned(),
        timeline_md_path: timeline_md_path.to_string_lossy().into_owned(),
        decisions_md_path: decisions_md_path.to_string_lossy().into_owned(),
        index_html_path: index_html_path.to_string_lossy().into_owned(),
        files_exported: manifest.files.len(),
        snapshots_written,
        metadata_only_count,
        event_count: manifest.events.len(),
        decision_count: manifest.decisions.len(),
        relation_count: manifest.relations.len(),
        redactions_applied: total_redactions,
        total_bytes,
    })
}

/// 另一台观澜秒开/核验开放胶囊目录：读取 `capsule-manifest.json` 并核验包内全部快照 SHA-256 完整性
pub fn inspect_capsule_dir(capsule_dir: &Path) -> Result<CapsuleInspectResponse, GuanlanError> {
    if !capsule_dir.is_dir() {
        return Err(GuanlanError::NotFound(format!(
            "胶囊目录不存在：{}",
            capsule_dir.display()
        )));
    }
    let manifest_path = capsule_dir.join("capsule-manifest.json");
    let raw = fs::read(&manifest_path).map_err(|e| {
        GuanlanError::NotFound(format!(
            "未找到 capsule-manifest.json（{}）：{e}",
            manifest_path.display()
        ))
    })?;
    let manifest: CapsuleManifest = serde_json::from_slice(&raw)
        .map_err(|e| GuanlanError::BadRequest(format!("capsule-manifest.json 解析失败：{e}")))?;
    if manifest.schema_version != CAPSULE_SCHEMA_VERSION {
        return Err(GuanlanError::BadRequest(format!(
            "不支持的胶囊协议版本：{}（期望 {CAPSULE_SCHEMA_VERSION}）",
            manifest.schema_version
        )));
    }

    let mut checked_snapshots: usize = 0;
    let mut integrity_issues: Vec<String> = Vec::new();
    for f in &manifest.files {
        if let Some(ref rel) = f.bundled_rel_path {
            match crate::storage::sandbox::resolve_existing_file_in_dir_jail(capsule_dir, rel) {
                Ok(abs_path) => match fs::read(&abs_path) {
                    Ok(bytes) => {
                        checked_snapshots += 1;
                        if let Some(ref expected) = f.bundled_sha256 {
                            let actual = sha256_hex_slice(&bytes);
                            if &actual != expected {
                                integrity_issues.push(format!(
                                    "快照 {rel} 哈希不匹配（期望 {}，实际 {}）",
                                    &expected[..12.min(expected.len())],
                                    &actual[..12]
                                ));
                            }
                        }
                    }
                    Err(e) => integrity_issues.push(format!("无法读取快照 {rel}：{e}")),
                },
                Err(e) => integrity_issues.push(format!("快照路径无效或缺失 {rel}：{e}")),
            }
        }
    }

    Ok(CapsuleInspectResponse {
        ok: true,
        capsule_dir: capsule_dir.to_string_lossy().into_owned(),
        integrity_ok: integrity_issues.is_empty(),
        checked_snapshots,
        integrity_issues,
        manifest,
    })
}

/// 另一台观澜阅读胶囊包内指定附带快照（沙箱严格限制在 `capsule_dir/files/` 之内，最大内联 1 MiB）
pub fn read_capsule_file(
    capsule_dir: &Path,
    bundled_rel_path: &str,
) -> Result<CapsuleFileContentResponse, GuanlanError> {
    const MAX_INLINE_BYTES: usize = 1024 * 1024;
    if !capsule_dir.is_dir() {
        return Err(GuanlanError::NotFound(format!(
            "胶囊目录不存在：{}",
            capsule_dir.display()
        )));
    }
    let clean_rel = validate_workspace_rel_path(bundled_rel_path)?;
    if !clean_rel.starts_with("files/") {
        return Err(GuanlanError::BadRequest(format!(
            "仅允许读取胶囊包 files/ 目录内的附带快照：{clean_rel}"
        )));
    }
    let abs = crate::storage::sandbox::resolve_existing_file_in_dir_jail(capsule_dir, &clean_rel)?;
    let bytes = fs::read(&abs)
        .map_err(|e| GuanlanError::Internal(format!("读取胶囊快照失败 {clean_rel}：{e}")))?;
    let size_bytes = bytes.len() as u64;
    let truncated = bytes.len() > MAX_INLINE_BYTES;
    let slice = if truncated {
        &bytes[..MAX_INLINE_BYTES]
    } else {
        bytes.as_slice()
    };
    let text = match std::str::from_utf8(slice) {
        Ok(s) => Some(s.to_owned()),
        Err(err) if truncated => std::str::from_utf8(&slice[..err.valid_up_to()])
            .ok()
            .map(ToOwned::to_owned),
        Err(_) => None,
    };
    Ok(CapsuleFileContentResponse {
        ok: true,
        bundled_rel_path: clean_rel,
        size_bytes,
        truncated,
        text,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::index::{reconcile, ReconcileOptions, Writer};

    struct TempCapsuleWs {
        dir: PathBuf,
        root: PathBuf,
        data: PathBuf,
        out: PathBuf,
    }

    impl TempCapsuleWs {
        fn new(tag: &str) -> Self {
            let nonce = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let dir = std::env::temp_dir()
                .join(format!("guanlan-f01-{tag}-{}-{nonce}", std::process::id()));
            let root = dir.join("ws");
            let data = dir.join("data");
            let out = dir.join("capsule-out");
            fs::create_dir_all(root.join("01-胶囊专项")).unwrap();
            fs::create_dir_all(root.join("01-胶囊专项/secrets")).unwrap();
            fs::create_dir_all(&data).unwrap();
            Self {
                dir,
                root,
                data,
                out,
            }
        }
    }

    impl Drop for TempCapsuleWs {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.dir);
        }
    }

    #[test]
    fn f01_preview_excludes_sensitive_dirs_and_export_rejects_missing_or_stale_token() {
        let ws = TempCapsuleWs::new("guard");
        fs::write(
            ws.root.join("01-胶囊专项/01-方案.md"),
            "# 胶囊专项方案\n\n内含需脱敏测试令牌：OPENAI_API_KEY=sk-proj-testsecretkey1234567890abcdef\n\n参考 [待确认事项](02-待确认事项.md)\n",
        )
        .unwrap();
        fs::write(
            ws.root.join("01-胶囊专项/02-待确认事项.md"),
            "# 待确认事项\n\n- [P0 - 待确认] **离线可读策略**：胶囊必须包含 TIMELINE.md 与 index.html。\n  - 决定：采用双形态开放目录 · 确认人：主公\n",
        )
        .unwrap();
        fs::write(
            ws.root.join("01-胶囊专项/secrets/prod-key.txt"),
            "TOP_SECRET_CREDENTIAL_DO_NOT_BUNDLE",
        )
        .unwrap();
        fs::write(ws.root.join("01-胶囊专项/.env"), "DB_PASSWORD=supersecret").unwrap();

        let mut writer = Writer::open_at(&ws.data, ws.root.to_str().unwrap()).unwrap();
        writer
            .set_initiative_dirs(&["01-胶囊专项".to_owned()])
            .unwrap();
        reconcile(&mut writer, &ReconcileOptions::default()).unwrap();
        drop(writer);

        let store = ReadonlyStore::open_at(&ws.data, ws.root.to_str().unwrap()).unwrap();
        let req = CapsulePreviewRequest {
            mode: CapsuleMode::WithSnapshots,
            sanitize_secrets: true,
            ..Default::default()
        };

        // 停机红线 1：未预览或无 preview_token 直接导出 → 立即以 PREVIEW_REQUIRED 拒绝
        let silent_err = export_capsule(
            &store,
            &CapsuleExportRequest {
                preview: req.clone(),
                preview_token: String::new(),
                confirmed_preview: false,
                output_dir: Some(ws.out.to_string_lossy().into_owned()),
            },
        )
        .expect_err("未预览静默导出必须被拒");
        assert!(silent_err.to_string().contains("PREVIEW_REQUIRED"));
        assert!(!ws.out.exists(), "被拒后绝不创建输出目录");

        // 阶段一：预览自动排除 secrets/ 与 .env，并检测出正文内 API Key 脱敏数
        let preview = preview_capsule(&store, &req).unwrap();
        assert_eq!(preview.selected_file_count, 2, "仅勾选两份正常文档");

        // 回归验证：显式传 initiative_id 按 initiatives.root_dir 精准匹配，绝不误报 404
        if let Ok(init_id) =
            store
                .conn()
                .query_row("SELECT initiative_id FROM initiatives LIMIT 1", [], |r| {
                    r.get::<_, String>(0)
                })
        {
            let init_preview = preview_capsule(
                &store,
                &CapsulePreviewRequest {
                    initiative_id: Some(init_id.clone()),
                    ..req.clone()
                },
            )
            .expect("带真实 initiative_id 预览必须命中 initiatives.root_dir 而非 404");
            assert_eq!(
                init_preview.initiative_id.as_deref(),
                Some(init_id.as_str())
            );
            assert!(init_preview.selected_file_count >= 1);
        }
        assert!(
            preview.sensitive_excluded_count >= 1,
            "敏感目录/文件必须自动排除"
        );
        assert!(
            preview.inline_redaction_count >= 1,
            "应检测到正文中的密钥片段"
        );
        for f in &preview.files {
            if f.relative_path.contains("secrets/") || f.relative_path.ends_with(".env") {
                assert!(!f.selected, "敏感路径默认不得被勾选：{}", f.relative_path);
                assert!(f.sensitive_path);
            }
        }

        // 阶段二：伪造过期 token → 拒收
        let stale_err = export_capsule(
            &store,
            &CapsuleExportRequest {
                preview: req.clone(),
                preview_token: "cap_prev_stale_token".to_owned(),
                confirmed_preview: true,
                output_dir: Some(ws.out.to_string_lossy().into_owned()),
            },
        )
        .expect_err("失配 token 必须拒收");
        assert!(stale_err.to_string().contains("PREVIEW_REQUIRED"));

        // 阶段二：携带真实 preview_token + confirmed_preview=true 成功导出
        let exported = export_capsule(
            &store,
            &CapsuleExportRequest {
                preview: req,
                preview_token: preview.preview_token.clone(),
                confirmed_preview: true,
                output_dir: Some(ws.out.to_string_lossy().into_owned()),
            },
        )
        .unwrap();
        assert_eq!(exported.files_exported, 2);
        assert_eq!(exported.snapshots_written, 2);
        assert!(exported.redactions_applied >= 1);

        // 验证开放目录可读性 + 脱敏生效 + 敏感文件零打包
        let timeline = fs::read_to_string(&exported.timeline_md_path).unwrap();
        assert!(timeline.contains("事项演进脉络"));
        assert!(timeline.contains("01-方案.md"));
        let decisions = fs::read_to_string(&exported.decisions_md_path).unwrap();
        assert!(decisions.contains("离线可读策略"));
        let html = fs::read_to_string(&exported.index_html_path).unwrap();
        assert!(html.contains("capsule-data"));
        let bundled_plan = fs::read_to_string(ws.out.join("files/01-胶囊专项/01-方案.md")).unwrap();
        assert!(bundled_plan.contains("[REDACTED_SECRET]"));
        assert!(!bundled_plan.contains("sk-proj-testsecretkey"));
        assert!(!ws
            .out
            .join("files/01-胶囊专项/secrets/prod-key.txt")
            .exists());
        assert!(!ws.out.join("files/01-胶囊专项/.env").exists());

        // 另一台观澜秒开校验：完整还原主干、决定与快照 SHA-256 全部通过
        let inspected = inspect_capsule_dir(&ws.out).unwrap();
        assert!(
            inspected.integrity_ok,
            "完整包核验应通过：{:?}",
            inspected.integrity_issues
        );
        assert_eq!(inspected.checked_snapshots, 2);
        assert_eq!(inspected.manifest.schema_version, CAPSULE_SCHEMA_VERSION);
        assert!(!inspected.manifest.decisions.is_empty());

        // manifest_only 模式不落 files/ 快照，仅带开放脉络与引用清单
        let out_manifest = ws.dir.join("capsule-manifest-only");
        let mo_req = CapsulePreviewRequest {
            mode: CapsuleMode::ManifestOnly,
            sanitize_secrets: true,
            ..Default::default()
        };
        let mo_prev = preview_capsule(&store, &mo_req).unwrap();
        let mo_exp = export_capsule(
            &store,
            &CapsuleExportRequest {
                preview: mo_req,
                preview_token: mo_prev.preview_token,
                confirmed_preview: true,
                output_dir: Some(out_manifest.to_string_lossy().into_owned()),
            },
        )
        .unwrap();
        assert_eq!(mo_exp.snapshots_written, 0);
        assert_eq!(mo_exp.metadata_only_count, 2);
        assert!(!out_manifest.join("files").exists());
    }
}
