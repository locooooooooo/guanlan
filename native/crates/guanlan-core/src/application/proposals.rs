//! 外部智能体修订草案（CAS 安全网、独立草案分支与 `derived_from_context` 因果边）。
//!
//! 职责边界：
//! - 统一计算独立草案分支版本标签 `v(N+1)-agent-draft`（与正式 `revisions.seq` 同源）；
//! - 规范化并校验外部智能体随草案提交的 `input_context_hashes` 上下文哈希清单与回执摘要；
//! - 确定性执行 CAS 乐观锁判定（`Clean` / `NoOp` / `Conflict`），冲突时绝不静默覆盖人工编辑；
//! - 采纳草案落版后，把已命中的上下文修订组装为 `edges(kind = 'derived_from_context')` 因果边，
//!   使每次 Agent 产出都能溯源到「读了哪几份快照、在哪个基线版本上生成」。

use std::collections::HashSet;

use crate::index::ident::stable_key;
use crate::storage::EdgeRow;

/// 因果边类型词：采纳智能体修订草案后记录的上下文溯源边
pub const DERIVED_FROM_CONTEXT_KIND: &str = "derived_from_context";

/// 单条草案允许携带的输入上下文哈希上限（防恶意或失控载荷膨胀 SQLite 行）
pub const MAX_INPUT_CONTEXT_HASHES: usize = 64;

/// 草案回执摘要单字段最大字符数（按 char 截断，绝不劈裂 UTF-8）
pub const MAX_RECEIPT_SUMMARY_CHARS: usize = 512;

/// 草案内容内联 Diff 预览字节上限（2 MiB，超大文件诚实标记 truncated 而非 OOM）
pub const MAX_DRAFT_PREVIEW_BYTES: usize = 2 * 1024 * 1024;

/// 依据目标文件最新已提交版本序号（或基准版本序号）生成独立草案分支标签：
/// `v(N+1)-agent-draft`（如基准 `seq = 2` → `v3-agent-draft`；无正数序号兜底 `v1-agent-draft`）。
pub fn draft_version_label(base_seq: i64) -> String {
    let next_seq = base_seq.max(0).saturating_add(1);
    format!("v{next_seq}-agent-draft")
}

/// 剥离可选的 `sha256:` / `SHA256:` 前缀（兼容模式 B `context_bundle` 与纯十六进制输入）
pub fn strip_sha256_prefix(raw: &str) -> &str {
    let trimmed = raw.trim();
    if let Some(rest) = trimmed.strip_prefix("sha256:") {
        rest.trim()
    } else if let Some(rest) = trimmed.strip_prefix("SHA256:") {
        rest.trim()
    } else {
        trimmed
    }
}

/// 规范化输入上下文哈希清单：去首尾空白、去空、按小写去重、保序、限制上限 [`MAX_INPUT_CONTEXT_HASHES`]。
pub fn normalize_context_hashes(hashes: &[String]) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for raw in hashes {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            continue;
        }
        let dedup_key = strip_sha256_prefix(trimmed).to_ascii_lowercase();
        if dedup_key.is_empty() || !seen.insert(dedup_key) {
            continue;
        }
        out.push(trimmed.to_owned());
        if out.len() >= MAX_INPUT_CONTEXT_HASHES {
            break;
        }
    }
    out
}

/// 规范化回执摘要：去首尾空白，空串归一为 `None`，超长按字符边界安全截断。
pub fn normalize_receipt_summary(raw: Option<&str>) -> Option<String> {
    let text = raw?.trim();
    if text.is_empty() {
        return None;
    }
    if text.chars().count() <= MAX_RECEIPT_SUMMARY_CHARS {
        return Some(text.to_owned());
    }
    let truncated: String = text.chars().take(MAX_RECEIPT_SUMMARY_CHARS).collect();
    Some(format!("{truncated}…"))
}

/// 从 SQLite `input_context_hashes_json` 列解析上下文哈希列表（损坏或空值安全降级为空 Vec）
pub fn parse_context_hashes_json(raw: &str) -> Vec<String> {
    let parsed = serde_json::from_str::<Vec<String>>(raw).unwrap_or_default();
    normalize_context_hashes(&parsed)
}

/// 将上下文哈希列表序列化为持久化 JSON 字符串
pub fn serialize_context_hashes(hashes: &[String]) -> String {
    let normalized = normalize_context_hashes(hashes);
    serde_json::to_string(&normalized).unwrap_or_else(|_| "[]".to_owned())
}

/// CAS 乐观锁判定结论
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProposalCasVerdict {
    Clean,
    NoOp,
    Conflict {
        expected_content_hash: String,
        disk_content_hash: String,
    },
}

impl ProposalCasVerdict {
    pub fn is_conflict(&self) -> bool {
        matches!(self, ProposalCasVerdict::Conflict { .. })
    }
}

/// 确定性 CAS 乐观锁核验：只要 `disk_hash != base_hash` 即判定冲突，绝不放行盲写。
pub fn evaluate_proposal_cas(
    base_hash: &str,
    disk_hash: &str,
    proposed_hash: &str,
) -> ProposalCasVerdict {
    if disk_hash != base_hash {
        return ProposalCasVerdict::Conflict {
            expected_content_hash: base_hash.to_owned(),
            disk_content_hash: disk_hash.to_owned(),
        };
    }
    if proposed_hash == disk_hash {
        ProposalCasVerdict::NoOp
    } else {
        ProposalCasVerdict::Clean
    }
}

/// 已解析到工作区具体修订的输入上下文目标
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DerivedContextTarget {
    pub file_id: String,
    pub revision_id: String,
    pub matched_hash: String,
}

/// 采纳草案落版后构造 `derived_from_context` 因果边。
///
/// 纪律：
/// - 每条边以新落盘正式版本 `source_revision_id` 为源，以本次输入上下文对应的 `(file_id, revision_id)` 为目标；
/// - 跳过指向「新落盘版本自身」的退化自环（`target.file_id == source_file_id && target.revision_id == source_revision_id`）；
/// - 按 `target_file_id` 保序去重，与 `edges` 表 `UNIQUE(source_revision_id, target_file_id, locator_start)` 约束对齐；
/// - `locator_start` / `locator_end` 统一记 `Some(0)`，与 1-based 正文行级 `explicit_reference` 边正交，互不覆盖。
pub fn build_derived_context_edges(
    workspace_id: &str,
    source_file_id: &str,
    source_revision_id: &str,
    draft_id: &str,
    draft_version_label: &str,
    receipt_summary: Option<&str>,
    targets: &[DerivedContextTarget],
) -> Vec<EdgeRow> {
    let mut seen_targets = HashSet::new();
    let mut rows = Vec::new();
    let receipt_hint = normalize_receipt_summary(receipt_summary);

    for target in targets {
        if target.file_id.is_empty() || target.revision_id.is_empty() {
            continue;
        }
        if target.file_id == source_file_id && target.revision_id == source_revision_id {
            continue;
        }
        if !seen_targets.insert(target.file_id.clone()) {
            continue;
        }
        let clean_hash = strip_sha256_prefix(&target.matched_hash);
        let short_hash = &clean_hash[..clean_hash.len().min(16)];
        let label = if draft_version_label.trim().is_empty() {
            "agent-draft"
        } else {
            draft_version_label.trim()
        };
        let reason = match &receipt_hint {
            Some(summary) => format!(
                "采纳智能体草案 {draft_id}（{label}）源自上下文快照 {short_hash}；回执：{summary}"
            ),
            None => format!("采纳智能体草案 {draft_id}（{label}）源自上下文快照 {short_hash}"),
        };
        let edge_id = format!(
            "edge_ctx_{}",
            stable_key(&format!(
                "{source_revision_id}|{}|{}|{DERIVED_FROM_CONTEXT_KIND}",
                target.file_id, target.revision_id
            ))
        );
        rows.push(EdgeRow {
            edge_id,
            workspace_id: workspace_id.to_owned(),
            source_file_id: source_file_id.to_owned(),
            source_revision_id: source_revision_id.to_owned(),
            target_file_id: target.file_id.clone(),
            target_revision_id: Some(target.revision_id.clone()),
            kind: DERIVED_FROM_CONTEXT_KIND.to_owned(),
            resolution: "exact".to_owned(),
            locator_start: Some(0),
            locator_end: Some(0),
            reason,
        });
    }

    rows
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn draft_version_label_formats_v_next_agent_draft() {
        assert_eq!(draft_version_label(0), "v1-agent-draft");
        assert_eq!(draft_version_label(1), "v2-agent-draft");
        assert_eq!(draft_version_label(7), "v8-agent-draft");
        assert_eq!(draft_version_label(-3), "v1-agent-draft");
    }

    #[test]
    fn normalize_context_hashes_dedups_case_and_prefix_and_caps() {
        let input = vec![
            "  sha256:AABBCCDD11223344  ".to_owned(),
            "aabbccdd11223344".to_owned(),
            "".to_owned(),
            "   ".to_owned(),
            "SHA256:deadbeef00112233".to_owned(),
        ];
        let out = normalize_context_hashes(&input);
        assert_eq!(
            out,
            vec![
                "sha256:AABBCCDD11223344".to_owned(),
                "SHA256:deadbeef00112233".to_owned()
            ]
        );
        assert_eq!(strip_sha256_prefix(&out[0]), "AABBCCDD11223344");
        assert_eq!(strip_sha256_prefix(&out[1]), "deadbeef00112233");

        let huge: Vec<String> = (0..100).map(|i| format!("hash_{i:016}")).collect();
        assert_eq!(
            normalize_context_hashes(&huge).len(),
            MAX_INPUT_CONTEXT_HASHES
        );
    }

    #[test]
    fn cas_verdict_protects_concurrent_human_edits() {
        assert_eq!(
            evaluate_proposal_cas("hash_v1", "hash_v1", "hash_v2"),
            ProposalCasVerdict::Clean
        );
        assert_eq!(
            evaluate_proposal_cas("hash_v1", "hash_v1", "hash_v1"),
            ProposalCasVerdict::NoOp
        );
        let conflict = evaluate_proposal_cas("hash_v1", "hash_human_edit", "hash_agent");
        assert!(conflict.is_conflict());
        assert_eq!(
            conflict,
            ProposalCasVerdict::Conflict {
                expected_content_hash: "hash_v1".to_owned(),
                disk_content_hash: "hash_human_edit".to_owned(),
            }
        );
    }

    #[test]
    fn build_derived_context_edges_dedups_and_records_provenance() {
        let targets = vec![
            DerivedContextTarget {
                file_id: "f_spec".to_owned(),
                revision_id: "rev_spec_2".to_owned(),
                matched_hash: "sha256:0123456789abcdef0123456789abcdef".to_owned(),
            },
            DerivedContextTarget {
                file_id: "f_spec".to_owned(),
                revision_id: "rev_spec_1".to_owned(),
                matched_hash: "aaaaaaaaaaaaaaaa".to_owned(),
            },
            DerivedContextTarget {
                file_id: "f_plan".to_owned(),
                revision_id: "rev_plan_3".to_owned(),
                matched_hash: "bbbbbbbbbbbbbbbb".to_owned(),
            },
            DerivedContextTarget {
                file_id: "f_plan".to_owned(),
                revision_id: "rev_plan_2".to_owned(),
                matched_hash: "cccccccccccccccc".to_owned(),
            },
        ];

        let edges = build_derived_context_edges(
            "ws_1",
            "f_plan",
            "rev_plan_3",
            "draft_abc",
            "v3-agent-draft",
            Some("依据架构规范补全状态机约束"),
            &targets,
        );
        assert_eq!(edges.len(), 2);
        assert_eq!(edges[0].kind, DERIVED_FROM_CONTEXT_KIND);
        assert_eq!(edges[0].target_file_id, "f_spec");
        assert_eq!(edges[0].target_revision_id.as_deref(), Some("rev_spec_2"));
        assert_eq!(edges[0].locator_start, Some(0));
        assert!(edges[0].reason.contains("v3-agent-draft"));
        assert!(edges[0].reason.contains("0123456789abcdef"));
        assert!(edges[0].reason.contains("依据架构规范补全状态机约束"));
        assert_eq!(edges[1].target_file_id, "f_plan");
        assert_eq!(edges[1].target_revision_id.as_deref(), Some("rev_plan_2"));
    }
}
