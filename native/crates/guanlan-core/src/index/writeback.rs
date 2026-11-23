//! 决策拍板回写（PRD v2.0 §3.3；冻结契约 C 的写线程执行体）。
//!
//! 三步原子操作（PRD 3.3 提交语义）：
//! 1. 结构化结果回写至本地 .md（替换下划线占位符，状态词变更 `[P1 - 已确认]`，
//!    front matter `revision+1` 仅当命中）——CAS 乐观锁（PRD 5.1）：磁盘内容哈希
//!    必须等于最新版本哈希，冲突绝不静默覆盖，改存草案分支；
//! 2. 单路径 changed_paths 对账（`reconcile_paths`，<200ms 通道）→ 新版本 →
//!    陈述重派生 → decision_changed 事件 → 状态机重算（阻塞3 裁定：唤醒=
//!    同步函数调用，无 job 载体）；
//! 3. `decision_writeback` 事件（subject_id=业务原 decision_id，阻塞4 非迁移类
//!    身份口径）。
//!
//! CAS 失败路径：`revision_drafts(status='proposed', conflict=1)` + `proposal_raised`
//! 事件，**不写工作区文件**；job 仍 completed（『处理拍板请求』本身成功）。
//!
//! 事务边界：磁盘 IO 在事务外（与 §0『快照落盘事务外』同口径）；本函数自管
//! 两段小事务（CAS 失败的草案+事件 / 成功后的回写事件），定向对账
//! [`crate::index::reconcile_paths`] 自带事务——调用方**不得**再包一层事务。

use std::sync::OnceLock;
use std::time::Instant;

use regex::Regex;

use crate::domain::sha256_hex;
use crate::error::GuanlanError;
use crate::index::clock;
use crate::index::derive::{decision_id_for, json_array, json_object, json_string};
use crate::index::ident::stable_key;
use crate::index::writer::{NewEvent, Writer};
use crate::index::{reconcile_paths, ReconcileOptions};
use crate::storage::{RevisionDraftRow, StatementRow};

/// 回写载荷（HTTP 层解析后传入；语义=PRD 3.3 表单字段）
#[derive(Debug, Clone)]
pub struct WritebackInput {
    pub statement_id: String,
    pub decision: String,
    pub confirmer: String,
    pub role: Option<String>,
    pub effective_scope: Option<String>,
    /// YYYY-MM-DD
    pub effective_date: Option<String>,
    pub note: Option<String>,
}

/// CAS 内容冲突明细（进 job report.writeback.cas_conflict）
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CasConflict {
    pub expected_content_hash: String,
    pub disk_content_hash: String,
}

/// 回写结果（job report.writeback 的来源）
#[derive(Debug, Clone, Default)]
pub struct WritebackOutcome {
    pub cas_ok: bool,
    pub file_changed: bool,
    pub new_revision_id: Option<String>,
    pub decision_id: String,
    pub cas_conflict: Option<CasConflict>,
    /// CAS 失败时落草案分支的 draft_id
    pub draft_id: Option<String>,
    /// E04：端到端拍板写回 + SQLite 版本提交 + 状态机重算耗时（毫秒；目标 <200ms）
    pub elapsed_ms: u64,
    /// E04：受影响专项 id（无归属专项为 None）
    pub initiative_id: Option<String>,
    /// E04：回写后该专项剩余阻塞未决数（P0+P1）
    pub remaining_pending_p0_p1: Option<i64>,
    /// E04：本次拍板是否解锁了下游被阻塞事项（P0+P1 清零且状态机离开 pending_review）
    pub unlocked_downstream: bool,
    /// E04：回写重算后专项状态（如 approved_revision / executing）
    pub initiative_state_after: Option<String>,
}

/// 决策回写执行体（写线程调用；自带事务边界，见模块注释）。
pub fn apply_decision_writeback(
    writer: &mut Writer,
    input: &WritebackInput,
) -> Result<WritebackOutcome, GuanlanError> {
    let started_at = Instant::now();
    let statement = writer
        .statement_by_id(&input.statement_id)?
        .ok_or_else(|| GuanlanError::NotFound(format!("未找到陈述 {}", input.statement_id)))?;
    let decision_id = statement
        .decision_id
        .clone()
        .unwrap_or_else(|| decision_id_for(&statement.namespace, &statement.question));
    let file = writer
        .get_file(&statement.file_id)?
        .ok_or_else(|| GuanlanError::NotFound(format!("未找到文件 {}", statement.file_id)))?;
    let rel_path = file.current_path.clone();

    // archived 主体守卫（冻结契约 F）：同步拒绝，回写不执行
    ensure_not_archived(writer, &statement.file_id)?;

    let workspace = writer.workspace()?;
    // E05 沙箱守卫：严格限制在授权工作区目录内，禁止路径逃逸或符号链接越界写入
    let disk_path =
        crate::storage::sandbox::resolve_workspace_file_in_jail(&workspace.root_path, &rel_path)?;
    let disk_bytes = std::fs::read(&disk_path).map_err(|e| {
        GuanlanError::Internal(format!("读取工作区文件失败 {}：{e}", disk_path.display()))
    })?;
    let disk_content = String::from_utf8_lossy(&disk_bytes).into_owned();
    let disk_hash = sha256_hex(disk_content.as_bytes());

    let latest = writer.latest_revision(&statement.file_id)?.ok_or_else(|| {
        GuanlanError::NotFound(format!("文件 {} 尚无已提交版本", statement.file_id))
    })?;
    let expected_hash = latest.content_hash.clone();

    // ---------- CAS：磁盘内容必须与最新版本一致（PRD 5.1 乐观锁） ----------
    if disk_hash != expected_hash {
        // 待写入内容 = 拍板后的形态（草案存「我们想写的内容」，供人机比对合并）
        let resolved = render_resolved_content(&disk_content, &statement, input);
        let resolved_hash = sha256_hex(resolved.as_bytes());
        let snapshot_rel = writer.write_snapshot_bytes(resolved.as_bytes(), &resolved_hash)?;
        let draft_id = format!(
            "draft_{}",
            stable_key(&format!(
                "{}|{}|{}",
                statement.file_id, latest.revision_id, disk_hash
            ))
        );
        let now = clock::now_iso();
        let workspace_id = workspace.workspace_id.clone();
        writer.transaction(|writer| {
            writer.upsert_revision_draft(&RevisionDraftRow {
                draft_id: draft_id.clone(),
                workspace_id: workspace_id.clone(),
                file_id: statement.file_id.clone(),
                base_revision_id: latest.revision_id.clone(),
                base_content_hash: expected_hash.clone(),
                proposed_content_hash: resolved_hash,
                snapshot_rel_path: snapshot_rel,
                source: "mcp".to_owned(),
                status: "proposed".to_owned(),
                conflict: 1,
                note: input.note.clone(),
                draft_version_label: crate::application::proposals::draft_version_label(latest.seq),
                input_context_hashes_json: crate::application::proposals::serialize_context_hashes(
                    std::slice::from_ref(&expected_hash),
                ),
                receipt_summary: Some(format!("拍板 CAS 冲突草案（{decision_id}）")),
                created_at: now.clone(),
                updated_at: now.clone(),
            })?;
            let payload = json_object(&[
                ("draft_id", json_string(&draft_id)),
                ("file_id", json_string(&statement.file_id)),
                ("path", json_string(&rel_path)),
                ("base_revision_id", json_string(&latest.revision_id)),
                ("reason", json_string("cas_conflict")),
                ("statement_id", json_string(&statement.statement_id)),
                ("decision_id", json_string(&decision_id)),
            ]);
            writer.insert_event(&NewEvent {
                event_id: format!("evt_proposal_raised_{}", stable_key(&draft_id)),
                workspace_id,
                kind: "proposal_raised".to_owned(),
                subject_kind: "draft".to_owned(),
                subject_id: draft_id.clone(),
                revision_id: Some(latest.revision_id.clone()),
                occurred_at: Some(now.clone()),
                occurred_precision: "second".to_owned(),
                occurred_source: Some("state_machine".to_owned()),
                observed_at: now,
                headline: format!("检测到并发修改，拍板结果已存草案：{}", rel_path),
                detail: format!(
                    "拍板请求与外部写入冲突（磁盘哈希 {} ≠ 版本哈希 {}）；内容存为草案分支 {}，绝不静默覆盖。",
                    &disk_hash[..16.min(disk_hash.len())],
                    &expected_hash[..16.min(expected_hash.len())],
                    draft_id
                ),
                payload_json: payload,
                batch_id: None,
            })?;
            Ok(())
        })?;
        return Ok(WritebackOutcome {
            cas_ok: false,
            file_changed: false,
            new_revision_id: None,
            decision_id,
            cas_conflict: Some(CasConflict {
                expected_content_hash: expected_hash,
                disk_content_hash: disk_hash,
            }),
            draft_id: Some(draft_id),
            elapsed_ms: started_at.elapsed().as_millis() as u64,
            ..Default::default()
        });
    }

    // ---------- 原位替换（PRD 3.3 第 1 步） ----------
    if statement.status == "已确认" {
        // 已拍板复述：内容不会变化，不重写文件、不造新版本（幂等重试口径）
        return Ok(WritebackOutcome {
            cas_ok: true,
            file_changed: false,
            new_revision_id: None,
            decision_id,
            cas_conflict: None,
            draft_id: None,
            elapsed_ms: started_at.elapsed().as_millis() as u64,
            ..Default::default()
        });
    }
    let resolved = render_resolved_content(&disk_content, &statement, input);
    let resolved_hash = sha256_hex(resolved.as_bytes());
    if resolved == disk_content {
        // 没有任何占位符可替换（块形态缺失）：如实报告，不造假新版本
        return Ok(WritebackOutcome {
            cas_ok: true,
            file_changed: false,
            new_revision_id: None,
            decision_id,
            cas_conflict: None,
            draft_id: None,
            elapsed_ms: started_at.elapsed().as_millis() as u64,
            ..Default::default()
        });
    }
    write_workspace_file_atomic(&disk_path, resolved.as_bytes(), &resolved_hash)?;

    // ---------- 单路径对账（冻结契约 C：新版本→陈述→决策事件→状态机重算） ----------
    let options = ReconcileOptions {
        observed_at: Some(clock::now_iso()),
        ..ReconcileOptions::default()
    };
    let report = reconcile_paths(writer, &options, std::slice::from_ref(&rel_path))?;
    let new_revision_id = writer
        .latest_revision(&statement.file_id)?
        .filter(|row| row.content_hash == resolved_hash)
        .map(|row| row.revision_id);

    // ---------- decision_writeback 事件（subject_id=业务原 decision_id） ----------
    let now = clock::now_iso();
    let payload = json_object(&[
        ("decision_id", json_string(&decision_id)),
        ("statement_id", json_string(&statement.statement_id)),
        ("file_id", json_string(&statement.file_id)),
        ("path", json_string(&rel_path)),
        (
            "new_revision_id",
            match &new_revision_id {
                Some(id) => json_string(id),
                None => "null".to_owned(),
            },
        ),
        ("confirmer", json_string(&input.confirmer)),
        (
            "role",
            match &input.role {
                Some(value) => json_string(value),
                None => "null".to_owned(),
            },
        ),
        (
            "effective_date",
            match &input.effective_date {
                Some(value) => json_string(value),
                None => "null".to_owned(),
            },
        ),
        ("changed_file_ids", json_array(&report.changed_file_ids)),
    ]);
    let workspace_id = workspace.workspace_id.clone();
    writer.transaction(|writer| {
        writer.insert_event(&NewEvent {
            event_id: format!(
                "evt_decision_writeback_{}",
                stable_key(&format!("{decision_id}|{now}"))
            ),
            workspace_id,
            kind: "decision_writeback".to_owned(),
            subject_kind: "decision".to_owned(),
            subject_id: decision_id.clone(),
            revision_id: new_revision_id.clone(),
            occurred_at: Some(now.clone()),
            occurred_precision: "second".to_owned(),
            occurred_source: Some("state_machine".to_owned()),
            observed_at: now,
            headline: format!("拍板回写完成：{}", statement.question),
            detail: format!(
                "决定「{}」由 {} 确认{}；{}",
                input.decision,
                input.confirmer,
                input
                    .effective_date
                    .as_deref()
                    .map(|date| format!("，生效日期 {date}"))
                    .unwrap_or_default(),
                new_revision_id
                    .as_deref()
                    .map(|id| format!("新版本 {id}"))
                    .unwrap_or_else(|| "内容无变化（无新版本）".to_owned())
            ),
            payload_json: payload,
            batch_id: None,
        })?;
        Ok(())
    })?;

    // E04：回写重算后读取该文件所属专项最新状态，确认未决扣减与下游解锁
    let initiative_id = writer
        .get_artifact_state(&statement.file_id)?
        .and_then(|row| row.initiative_id);
    let (remaining_pending_p0_p1, initiative_state_after, unlocked_downstream) =
        if let Some(ref init_id) = initiative_id {
            if let Some(init_row) = writer.get_initiative(&workspace.workspace_id, init_id)? {
                let remaining = init_row.pending_p0 + init_row.pending_p1;
                let unlocked = remaining == 0 && init_row.state != "pending_review";
                (Some(remaining), Some(init_row.state), unlocked)
            } else {
                (None, None, false)
            }
        } else {
            (None, None, false)
        };

    Ok(WritebackOutcome {
        cas_ok: true,
        file_changed: new_revision_id.is_some(),
        new_revision_id,
        decision_id,
        cas_conflict: None,
        draft_id: None,
        elapsed_ms: started_at.elapsed().as_millis() as u64,
        initiative_id,
        remaining_pending_p0_p1,
        unlocked_downstream,
        initiative_state_after,
    })
}

/// archived 主体守卫：文件所属专项 state='archived' → CONFLICT（冻结契约 F）
pub fn ensure_not_archived(writer: &Writer, file_id: &str) -> Result<(), GuanlanError> {
    let Some(state_row) = writer.get_artifact_state(file_id)? else {
        return Ok(());
    };
    let Some(initiative_id) = state_row.initiative_id else {
        return Ok(());
    };
    let workspace_id = writer.workspace()?.workspace_id;
    if let Some(initiative) = writer.get_initiative(&workspace_id, &initiative_id)? {
        if initiative.state == "archived" {
            return Err(GuanlanError::Conflict("已归档文档需先人工重开".to_owned()));
        }
    }
    Ok(())
}

/// 拍板后的内容形态：状态词变更 + 占位符替换 + front matter revision+1
fn render_resolved_content(
    content: &str,
    statement: &StatementRow,
    input: &WritebackInput,
) -> String {
    static RESOLVER: OnceLock<BlockResolver> = OnceLock::new();
    let pat = RESOLVER.get_or_init(|| BlockResolver {
        status_pending: Regex::new(r"状态[：:]\s*\*{0,2}待确认\*{0,2}").expect("状态词"),
        decision: Regex::new(r"(决定[：:]\s*)(_{2,}|…+|—+)").expect("决定占位"),
        confirmer: Regex::new(r"(确认人[：:]\s*)(_{2,}|…+|—+)").expect("确认人占位"),
        role: Regex::new(r"(角色[：:]\s*)(_{2,}|…+|—+)").expect("角色占位"),
        scope: Regex::new(r"(生效范围与日期[：:]\s*)(_{2,}|…+|—+)").expect("生效范围占位"),
        front_matter: Regex::new(r"(?s)^---\r?\n(.*?)\r?\n---").expect("front matter"),
        revision_line: Regex::new(r"(?m)^revision:\s*(\d+)\s*$").expect("revision 行"),
    });
    // P0/P1/P2 各自独立编译缓存，避免进程内先处理某一级后锁定其他级别
    static MARKER_CACHE: OnceLock<[Regex; 3]> = OnceLock::new();
    let markers = MARKER_CACHE.get_or_init(|| {
        [
            Regex::new(r"\[\s*P0\s*[-—–]?\s*待确认\s*\]").expect("P0 块标记"),
            Regex::new(r"\[\s*P1\s*[-—–]?\s*待确认\s*\]").expect("P1 块标记"),
            Regex::new(r"\[\s*P2\s*[-—–]?\s*待确认\s*\]").expect("P2 块标记"),
        ]
    });

    let lines: Vec<&str> = content.split('\n').collect();
    let start = (statement.line_start.max(1) as usize).saturating_sub(1);
    let end = (statement.line_end.max(1) as usize).min(lines.len());
    let code_trimmed = statement.code.trim();
    let priority = if matches!(code_trimmed, "P0" | "P1" | "P2") {
        code_trimmed.to_owned()
    } else {
        serde_json::from_str::<serde_json::Value>(&statement.detail_json)
            .ok()
            .and_then(|v| {
                v.get("priority")
                    .and_then(|p| p.as_str())
                    .map(str::to_owned)
            })
            .filter(|p| matches!(p.as_str(), "P0" | "P1" | "P2"))
            .unwrap_or_else(|| code_trimmed.to_owned())
    };
    let marker = match priority.as_str() {
        "P0" => Some(markers[0].clone()),
        "P1" => Some(markers[1].clone()),
        "P2" => Some(markers[2].clone()),
        _ => None,
    };

    let effective = match (&input.effective_scope, &input.effective_date) {
        (Some(scope), Some(date)) => {
            if scope.contains(date.as_str()) {
                scope.clone()
            } else {
                format!("{scope}，{date}")
            }
        }
        (Some(scope), None) => scope.clone(),
        (None, Some(date)) => date.clone(),
        (None, None) => String::new(),
    };

    let mut out: Vec<String> = Vec::with_capacity(lines.len());
    for (index, line) in lines.iter().enumerate() {
        let mut line: String = (*line).to_owned();
        if index >= start && index < end {
            // 状态词：块标记优先（[P1 - 待确认] → [P1 - 已确认]）
            if let Some(marker) = &marker {
                let replacement = format!("[{priority} - 已确认]");
                let after = marker
                    .replace(&line, escape_replacement(&replacement))
                    .into_owned();
                if after != line {
                    line = after;
                }
            }
            let after = pat
                .status_pending
                .replace(&line, "状态：已确认")
                .into_owned();
            if after != line {
                line = after;
            }
            // 占位符：决定/确认人/角色/生效范围与日期（仅替换下划线占位，保留字段前缀）
            let after = pat
                .decision
                .replace(
                    &line,
                    format!("${{1}}{}", escape_replacement(&input.decision)),
                )
                .into_owned();
            line = after;
            let after = pat
                .confirmer
                .replace(
                    &line,
                    format!("${{1}}{}", escape_replacement(&input.confirmer)),
                )
                .into_owned();
            line = after;
            if let Some(role) = &input.role {
                line = pat
                    .role
                    .replace(&line, format!("${{1}}{}", escape_replacement(role)))
                    .into_owned();
            }
            if !effective.is_empty() {
                line = pat
                    .scope
                    .replace(&line, format!("${{1}}{}", escape_replacement(&effective)))
                    .into_owned();
            }
        }
        out.push(line);
    }
    let mut resolved = out.join("\n");

    // front matter revision+1：仅当命中且含 revision 行（冻结契约 C）
    if pat.front_matter.is_match(&resolved) {
        if let Some(captures) = pat.revision_line.captures(&resolved) {
            let current: u64 = captures
                .get(1)
                .and_then(|m| m.as_str().parse().ok())
                .unwrap_or(0);
            let bumped = format!("revision: {}", current + 1);
            resolved = pat
                .revision_line
                .replace(&resolved, bumped.as_str())
                .into_owned();
        }
    }
    resolved
}

/// regex 替换串的 `$` 转义（拍板文本里出现 `$` 时不被当作引用组）
fn escape_replacement(text: &str) -> String {
    text.replace('$', "$$")
}

/// 块级替换正则集（编译一次）
struct BlockResolver {
    status_pending: Regex,
    decision: Regex,
    confirmer: Regex,
    role: Regex,
    scope: Regex,
    front_matter: Regex,
    revision_line: Regex,
}

/// 工作区文件原子写入（writer.rs:982-1014 模式）：临时文件 → 重读校验 →
/// 同目录原子改名。校验失败删除临时文件并报错，绝不留下半成品。
fn write_workspace_file_atomic(
    target: &std::path::Path,
    content: &[u8],
    expected_hash: &str,
) -> Result<(), GuanlanError> {
    use std::io::Read;
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let tmp = target.with_extension(format!("guanlan-tmp-{}-{nanos:x}", std::process::id()));
    std::fs::write(&tmp, content)
        .map_err(|e| GuanlanError::Internal(format!("写临时文件失败 {}：{e}", tmp.display())))?;
    let mut verify = Vec::with_capacity(content.len());
    std::fs::File::open(&tmp)
        .and_then(|mut f| f.read_to_end(&mut verify))
        .map_err(|e| {
            let _ = std::fs::remove_file(&tmp);
            GuanlanError::Internal(format!("重读临时文件失败 {}：{e}", tmp.display()))
        })?;
    if sha256_hex(&verify) != expected_hash {
        let _ = std::fs::remove_file(&tmp);
        return Err(GuanlanError::Internal(format!(
            "临时文件校验失败（写入内容与哈希不符）：{}",
            target.display()
        )));
    }
    std::fs::rename(&tmp, target).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        GuanlanError::Internal(format!("原子改名失败 {}：{e}", target.display()))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::index::writer::Writer;
    use crate::index::{reconcile, ReconcileOptions};

    struct TempWorkspace {
        root: std::path::PathBuf,
        data: std::path::PathBuf,
    }

    impl TempWorkspace {
        fn new(tag: &str) -> Self {
            let base =
                std::env::temp_dir().join(format!("guanlan-wb-{}-{tag}", std::process::id()));
            let _ = std::fs::remove_dir_all(&base);
            let root = base.join("workspace");
            let data = base.join("data");
            std::fs::create_dir_all(&root).expect("建工作区");
            std::fs::create_dir_all(&data).expect("建数据目录");
            Self { root, data }
        }

        fn write(&self, rel: &str, content: &str) {
            let path = self.root.join(rel);
            std::fs::create_dir_all(path.parent().expect("父目录")).expect("建父目录");
            std::fs::write(path, content).expect("写文件");
        }

        fn writer(&self) -> Writer {
            Writer::open_at(&self.data, &self.root.to_string_lossy().replace('\\', "/"))
                .expect("打开写库")
        }
    }

    impl Drop for TempWorkspace {
        fn drop(&mut self) {
            if let Some(base) = self.root.parent() {
                let _ = std::fs::remove_dir_all(base);
            }
        }
    }

    const PENDING_MD: &str = "---\nrevision: 1\n---\n\n# 03-待确认事项\n\n[P1 - 待确认] 属性字典与历史更新策略\n决定：___\n确认人：___\n生效范围与日期：___\n";

    fn seed(ws: &TempWorkspace) -> (Writer, String) {
        ws.write("01-演示专项/03-待确认事项.md", PENDING_MD);
        let mut writer = ws.writer();
        let report = reconcile(
            &mut writer,
            &ReconcileOptions {
                observed_at: Some("2026-11-17T00:00:00.000Z".to_owned()),
                ..Default::default()
            },
        )
        .expect("基线对账");
        let _ = report;
        (writer, "01-演示专项/03-待确认事项.md".to_owned())
    }

    fn input_of(statement_id: &str) -> WritebackInput {
        WritebackInput {
            statement_id: statement_id.to_owned(),
            decision: "采用两阶段状态锁".to_owned(),
            confirmer: "架构组".to_owned(),
            role: Some("决策组".to_owned()),
            effective_scope: Some("全量专项".to_owned()),
            effective_date: Some("2026-11-18".to_owned()),
            note: None,
        }
    }

    #[test]
    fn writeback_replaces_placeholders_and_creates_revision() {
        let ws = TempWorkspace::new("ok");
        let (mut writer, _rel) = seed(&ws);

        // 找到卡点块陈述（回写目标）
        let workspace_id = writer.workspace().expect("ws").workspace_id;
        let statements = writer.list_statements(&workspace_id).expect("查陈述");
        let target = statements
            .iter()
            .find(|row| row.status == "待确认" && row.code == "P1")
            .expect("卡点块陈述应已抽出")
            .statement_id
            .clone();

        let outcome = apply_decision_writeback(&mut writer, &input_of(&target)).expect("回写成功");
        assert!(outcome.cas_ok);
        assert!(outcome.file_changed, "内容变化必须有新版本");
        let new_revision = outcome.new_revision_id.expect("新版本");

        // 文件内容：状态词 + 占位符 + frontmatter revision 全部就位
        let content = std::fs::read_to_string(ws.root.join("01-演示专项/03-待确认事项.md"))
            .expect("读回写后文件");
        assert!(content.contains("[P1 - 已确认]"), "状态词变更：{content}");
        assert!(
            content.contains("决定：采用两阶段状态锁"),
            "决定回填：{content}"
        );
        assert!(content.contains("确认人：架构组"), "确认人回填：{content}");
        assert!(
            content.contains("生效范围与日期：全量专项，2026-11-18"),
            "生效范围回填：{content}"
        );
        assert!(
            content.contains("revision: 2"),
            "frontmatter revision+1：{content}"
        );

        // 新版本与新陈述（已确认）落库
        let revision = writer
            .get_revision(&new_revision)
            .expect("查版本")
            .expect("存在");
        assert_eq!(revision.seq, 2);
        let statements = writer.list_statements(&workspace_id).expect("查陈述");
        assert!(
            statements
                .iter()
                .any(|row| row.revision_id == new_revision && row.status == "已确认"),
            "回写后版本应有已确认陈述"
        );
        // decision_writeback 事件
        let events = writer
            .list_events_of_subject(&workspace_id, &outcome.decision_id, &["decision_writeback"])
            .expect("查事件");
        assert_eq!(events.len(), 1, "一条 decision_writeback 事件");
    }

    #[test]
    fn writeback_cas_conflict_goes_to_draft_branch() {
        let ws = TempWorkspace::new("cas");
        let (mut writer, rel) = seed(&ws);

        let workspace_id = writer.workspace().expect("ws").workspace_id;
        let statements = writer.list_statements(&workspace_id).expect("查陈述");
        let target = statements
            .iter()
            .find(|row| row.status == "待确认")
            .expect("待确认陈述")
            .statement_id
            .clone();

        // 外部写入改了磁盘（CAS 前提被破坏）
        ws.write(
            &rel,
            "---\nrevision: 1\n---\n\n# 03-待确认事项\n\n外部修改\n",
        );
        let outcome = apply_decision_writeback(&mut writer, &input_of(&target)).expect("受理成功");
        assert!(!outcome.cas_ok, "CAS 应失败");
        assert!(!outcome.file_changed);
        assert!(outcome.new_revision_id.is_none());
        let conflict = outcome.cas_conflict.expect("CAS 冲突明细");
        assert_eq!(conflict.expected_content_hash.len(), 64);
        assert_ne!(conflict.expected_content_hash, conflict.disk_content_hash);

        // 草案分支 + proposal_raised 事件；工作区文件未被覆盖
        let drafts = writer
            .list_revision_drafts(&workspace_id, None, Some("proposed"))
            .expect("查草案");
        assert_eq!(drafts.len(), 1, "落一条 conflict=1 的草案");
        assert_eq!(drafts[0].conflict, 1);
        assert_eq!(drafts[0].source, "mcp");
        let disk = std::fs::read_to_string(ws.root.join(&rel)).expect("读磁盘");
        assert!(disk.contains("外部修改"), "绝不静默覆盖人工修改：{disk}");
        let events = writer
            .list_events_of_subject(
                &workspace_id,
                &outcome.draft_id.expect("draft_id"),
                &["proposal_raised"],
            )
            .expect("查事件");
        assert_eq!(events.len(), 1);
    }

    #[test]
    fn writeback_is_idempotent_for_already_resolved_statement() {
        let ws = TempWorkspace::new("idem");
        let (mut writer, _rel) = seed(&ws);
        let workspace_id = writer.workspace().expect("ws").workspace_id;
        let statements = writer.list_statements(&workspace_id).expect("查陈述");
        let target = statements
            .iter()
            .find(|row| row.status == "待确认")
            .expect("待确认陈述")
            .statement_id
            .clone();

        let first = apply_decision_writeback(&mut writer, &input_of(&target)).expect("首次回写");
        assert!(first.file_changed);

        // 对已确认陈述重复回写：无新版本、无第二次 decision_writeback 事件
        let again_statement = writer
            .statements_of_revision(&first.new_revision_id.expect("新版本"))
            .expect("查新陈述");
        let resolved_target = again_statement
            .iter()
            .find(|row| row.status == "已确认")
            .expect("已确认陈述")
            .statement_id
            .clone();
        let second =
            apply_decision_writeback(&mut writer, &input_of(&resolved_target)).expect("重复回写");
        assert!(second.cas_ok);
        assert!(!second.file_changed, "已确认陈述复述不造新版本");
        assert!(second.new_revision_id.is_none());
    }

    #[test]
    fn writeback_handles_mixed_priorities_and_dedups_embedded_date() {
        let doc = "---\nrevision: 1\n---\n\n[P1 - 待确认] 第一项\n决定：___\n确认人：___\n生效范围与日期：___\n\n[P0 - 待确认] 第二项\n决定：___\n确认人：___\n生效范围与日期：___\n";
        let stmt_p1 = StatementRow {
            statement_id: "s1".to_owned(),
            workspace_id: "w1".to_owned(),
            file_id: "f1".to_owned(),
            revision_id: "r1".to_owned(),
            code: "P1".to_owned(),
            namespace: "ns".to_owned(),
            question: "第一项".to_owned(),
            status: "待确认".to_owned(),
            quote: String::new(),
            line_start: 5,
            line_end: 8,
            decision_id: Some("d1".to_owned()),
            detail_json: "{}".to_owned(),
            extract_rule_version: "v0.4.3".to_owned(),
            observed_at: "2026-11-18T00:00:00Z".to_owned(),
        };
        let mut input1 = input_of("s1");
        input1.effective_scope = Some("2026-11-18".to_owned());
        input1.effective_date = Some("2026-11-18".to_owned());
        let after_p1 = render_resolved_content(doc, &stmt_p1, &input1);
        assert!(after_p1.contains("[P1 - 已确认]"));
        assert!(
            after_p1.contains("生效范围与日期：2026-11-18\n"),
            "不得重复拼接同日日期：{after_p1}"
        );

        let stmt_p0 = StatementRow {
            statement_id: "s0".to_owned(),
            code: "P0".to_owned(),
            question: "第二项".to_owned(),
            line_start: 10,
            line_end: 13,
            ..stmt_p1
        };
        let after_p0 = render_resolved_content(&after_p1, &stmt_p0, &input_of("s0"));
        assert!(
            after_p0.contains("[P0 - 已确认]"),
            "P1 之后再处理 P0 必须独立命中 P0 标记：{after_p0}"
        );
    }
}
