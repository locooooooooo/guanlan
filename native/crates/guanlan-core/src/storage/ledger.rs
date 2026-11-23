//! 关键决定账本防篡改哈希链与完整性审计（E05 安全护城河）。
//!
//! 设计口径：
//! - 零新增第三方 crate（直接复用既有 `sha2::Sha256`）；
//! - 每次关键决定/草案/检查点/治理事件落库 `events` 时，在同一写事务内原子追加一条
//!   `decision_ledger_chain` 链节点，记录：
//!   1. `record_hash`：对该 `events` 关键载荷（workspace_id/event_id/kind/subject/revision/
//!      timestamps/headline/detail/payload_json）的规范 SHA-256 摘要；
//!   2. `prev_hash`：上一条链节点的 `chain_hash`（首条为 64 个 `'0'` 创世哈希）；
//!   3. `chain_hash`：`SHA-256("chain_v1|" + prev_hash + "|" + record_hash + "|" + event_id + "|" + event_kind)`；
//! - 并在 `meta` 表原子推进 `ledger_chain_head_hash` 与 `ledger_chain_head_seq` 链头锚点，
//!   防止连同尾部链行与事件行一并截断；
//! - 只读审计函数 [`verify_decision_ledger`] 可由 `GET /api/v1/audit/ledger` 与 CLI 诊断命令
//!   `guanlan audit --root <目录>` 随时零副作用运行，篡改任意关键决定事件字段、修改/删除链节点、
//!   绕过账本伪造未封存决定事件、或删改链尾，均可立即精确定位并报错。

use std::collections::HashSet;

use rusqlite::{params, Connection};
use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::error::GuanlanError;
use crate::storage::{internal_sql, ReadonlyStore};

/// 创世前置哈希（64 位全零）
pub const GENESIS_PREV_HASH: &str =
    "0000000000000000000000000000000000000000000000000000000000000000";

/// `meta` 表中保存的账本链头锚点键名
pub const META_LEDGER_HEAD_HASH: &str = "ledger_chain_head_hash";
pub const META_LEDGER_HEAD_SEQ: &str = "ledger_chain_head_seq";

/// 进入防篡改哈希链的关键决定与治理事件种类
pub const LEDGER_SEALED_EVENT_KINDS: &[&str] = &[
    "decision_writeback",
    "decision_changed",
    "proposal_raised",
    "proposal_adopted",
    "proposal_dismissed",
    "checkpoint_committed",
    "orphan_repaired",
    "initiative_archived",
    "initiative_reopened",
];

/// 判断事件种类是否属于关键决定账本封存范围
pub fn is_ledger_sealed_kind(kind: &str) -> bool {
    LEDGER_SEALED_EVENT_KINDS.contains(&kind)
}

/// 参与规范哈希计算的事件快照字段（与 `events` 表一一对应）
#[derive(Debug, Clone)]
pub struct LedgerEventSnapshot<'a> {
    pub workspace_id: &'a str,
    pub event_id: &'a str,
    pub kind: &'a str,
    pub subject_kind: &'a str,
    pub subject_id: &'a str,
    pub revision_id: Option<&'a str>,
    pub occurred_at: Option<&'a str>,
    pub observed_at: &'a str,
    pub headline: &'a str,
    pub detail: &'a str,
    pub payload_json: &'a str,
}

/// 账本审计异常项
#[derive(Debug, Clone, Serialize)]
pub struct LedgerAuditIssue {
    /// `chain_link_broken` | `chain_hash_mismatch` | `event_missing` |
    /// `event_content_tampered` | `unsealed_decision_event` | `head_mismatch` |
    /// `revision_missing`
    pub code: String,
    pub chain_seq: Option<i64>,
    pub event_id: Option<String>,
    pub detail: String,
}

/// 账本哈希链完整性审计报告
#[derive(Debug, Clone, Serialize)]
pub struct LedgerAuditReport {
    pub ok: bool,
    pub table_present: bool,
    pub verified_entries: usize,
    pub sealed_events_total: usize,
    pub head_chain_seq: Option<i64>,
    pub head_chain_hash: Option<String>,
    pub issues: Vec<LedgerAuditIssue>,
}

fn sha256_hex_bytes(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut out = String::with_capacity(64);
    for byte in digest {
        use std::fmt::Write as _;
        let _ = write!(&mut out, "{byte:02x}");
    }
    out
}

fn push_len_prefixed(buf: &mut Vec<u8>, field: &str) {
    let len = field.len().to_string();
    buf.extend_from_slice(len.as_bytes());
    buf.push(b':');
    buf.extend_from_slice(field.as_bytes());
    buf.push(b'|');
}

/// 计算单条关键事件的规范内容摘要（长度前缀编码消除字段边界碰撞）
pub fn compute_event_record_hash(ev: &LedgerEventSnapshot<'_>) -> String {
    let mut buf = Vec::with_capacity(256);
    buf.extend_from_slice(b"guanlan_ledger_rec_v1|");
    push_len_prefixed(&mut buf, ev.workspace_id);
    push_len_prefixed(&mut buf, ev.event_id);
    push_len_prefixed(&mut buf, ev.kind);
    push_len_prefixed(&mut buf, ev.subject_kind);
    push_len_prefixed(&mut buf, ev.subject_id);
    push_len_prefixed(&mut buf, ev.revision_id.unwrap_or(""));
    push_len_prefixed(&mut buf, ev.occurred_at.unwrap_or(""));
    push_len_prefixed(&mut buf, ev.observed_at);
    push_len_prefixed(&mut buf, ev.headline);
    push_len_prefixed(&mut buf, ev.detail);
    push_len_prefixed(&mut buf, ev.payload_json);
    sha256_hex_bytes(&buf)
}

/// 计算链节点哈希（绑定前驱链哈希 + 当前记录哈希 + 事件身份与种类）
pub fn compute_chain_hash(
    prev_hash: &str,
    record_hash: &str,
    event_id: &str,
    event_kind: &str,
) -> String {
    let mut buf = Vec::with_capacity(192);
    buf.extend_from_slice(b"guanlan_ledger_chain_v1|");
    push_len_prefixed(&mut buf, prev_hash);
    push_len_prefixed(&mut buf, record_hash);
    push_len_prefixed(&mut buf, event_id);
    push_len_prefixed(&mut buf, event_kind);
    sha256_hex_bytes(&buf)
}

/// 在写连接的当前事务内原子追加一条账本哈希链节点，并推进 `meta` 链头锚点。
pub fn seal_event_in_ledger(
    conn: &Connection,
    event_seq: i64,
    ev: &LedgerEventSnapshot<'_>,
) -> Result<String, GuanlanError> {
    let prev_hash: String = conn
        .query_row(
            "SELECT chain_hash
             FROM decision_ledger_chain
             WHERE workspace_id = ?
             ORDER BY chain_seq DESC
             LIMIT 1",
            [ev.workspace_id],
            |row| row.get(0),
        )
        .unwrap_or_else(|_| GENESIS_PREV_HASH.to_owned());

    let record_hash = compute_event_record_hash(ev);
    let chain_hash = compute_chain_hash(&prev_hash, &record_hash, ev.event_id, ev.kind);

    conn.execute(
        "INSERT INTO decision_ledger_chain
           (workspace_id, event_id, event_seq, event_kind, subject_id, revision_id,
            record_hash, prev_hash, chain_hash, sealed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        params![
            ev.workspace_id,
            ev.event_id,
            event_seq,
            ev.kind,
            ev.subject_id,
            ev.revision_id,
            record_hash,
            prev_hash,
            chain_hash,
            ev.observed_at,
        ],
    )
    .map_err(internal_sql)?;

    let chain_seq = conn.last_insert_rowid();
    conn.execute(
        "INSERT INTO meta (key, value) VALUES (?, ?)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value",
        params![META_LEDGER_HEAD_HASH, chain_hash],
    )
    .map_err(internal_sql)?;
    conn.execute(
        "INSERT INTO meta (key, value) VALUES (?, ?)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value",
        params![META_LEDGER_HEAD_SEQ, chain_seq.to_string()],
    )
    .map_err(internal_sql)?;

    Ok(chain_hash)
}

#[derive(Debug)]
struct LedgerRow {
    chain_seq: i64,
    event_id: String,
    event_kind: String,
    subject_id: String,
    revision_id: Option<String>,
    record_hash: String,
    prev_hash: String,
    chain_hash: String,
}

#[derive(Debug)]
struct LiveEventRow {
    workspace_id: String,
    event_id: String,
    kind: String,
    subject_kind: String,
    subject_id: String,
    revision_id: Option<String>,
    occurred_at: Option<String>,
    observed_at: String,
    headline: String,
    detail: String,
    payload_json: String,
}

/// 只读校验整个工作区决定账本哈希链完整性（零写库副作用）。
pub fn verify_decision_ledger(store: &ReadonlyStore) -> Result<LedgerAuditReport, GuanlanError> {
    let ws = store.workspace()?;
    store.read_txn(|conn| verify_decision_ledger_on_conn(conn, &ws.workspace_id))
}

/// 基于任意只读/读写 SQLite 连接执行完整性校验（供 `ReadonlyStore` 与单测共享）
pub fn verify_decision_ledger_on_conn(
    conn: &Connection,
    workspace_id: &str,
) -> Result<LedgerAuditReport, GuanlanError> {
    let table_present: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'decision_ledger_chain')",
            [],
            |row| row.get::<_, i64>(0),
        )
        .map_err(internal_sql)?
        != 0;

    if !table_present {
        return Ok(LedgerAuditReport {
            ok: true,
            table_present: false,
            verified_entries: 0,
            sealed_events_total: 0,
            head_chain_seq: None,
            head_chain_hash: None,
            issues: Vec::new(),
        });
    }

    let mut issues: Vec<LedgerAuditIssue> = Vec::new();

    // 1. 读取全部链节点（按 chain_seq 严格递增）
    let mut stmt = conn
        .prepare(
            "SELECT chain_seq, event_id, event_kind, subject_id, revision_id,
                    record_hash, prev_hash, chain_hash
             FROM decision_ledger_chain
             WHERE workspace_id = ?
             ORDER BY chain_seq ASC",
        )
        .map_err(internal_sql)?;
    let chain_rows: Vec<LedgerRow> = stmt
        .query_map([workspace_id], |row| {
            Ok(LedgerRow {
                chain_seq: row.get(0)?,
                event_id: row.get(1)?,
                event_kind: row.get(2)?,
                subject_id: row.get(3)?,
                revision_id: row.get(4)?,
                record_hash: row.get(5)?,
                prev_hash: row.get(6)?,
                chain_hash: row.get(7)?,
            })
        })
        .map_err(internal_sql)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(internal_sql)?;

    let mut expected_prev = GENESIS_PREV_HASH.to_owned();
    let mut verified_entries: usize = 0;
    let mut sealed_event_ids: HashSet<String> = HashSet::with_capacity(chain_rows.len());

    // 2. 逐条核对链接连续性、链哈希与底层 events 表实时内容摘要
    for entry in &chain_rows {
        sealed_event_ids.insert(entry.event_id.clone());
        let mut entry_ok = true;

        if entry.prev_hash != expected_prev {
            entry_ok = false;
            issues.push(LedgerAuditIssue {
                code: "chain_link_broken".to_owned(),
                chain_seq: Some(entry.chain_seq),
                event_id: Some(entry.event_id.clone()),
                detail: format!(
                    "链节点 #{} 的 prev_hash 断裂（期望 {}，实际 {}）",
                    entry.chain_seq,
                    &expected_prev[..16.min(expected_prev.len())],
                    &entry.prev_hash[..16.min(entry.prev_hash.len())]
                ),
            });
        }

        let recomputed_chain = compute_chain_hash(
            &entry.prev_hash,
            &entry.record_hash,
            &entry.event_id,
            &entry.event_kind,
        );
        if recomputed_chain != entry.chain_hash {
            entry_ok = false;
            issues.push(LedgerAuditIssue {
                code: "chain_hash_mismatch".to_owned(),
                chain_seq: Some(entry.chain_seq),
                event_id: Some(entry.event_id.clone()),
                detail: format!(
                    "链节点 #{} 的 chain_hash 被篡改（重算 {}，库内 {}）",
                    entry.chain_seq,
                    &recomputed_chain[..16],
                    &entry.chain_hash[..16.min(entry.chain_hash.len())]
                ),
            });
        }

        // 读取实时 events 行核对内容摘要
        let live_event: Option<LiveEventRow> = conn
            .query_row(
                "SELECT workspace_id, event_id, kind, subject_kind, subject_id, revision_id,
                        occurred_at, observed_at, headline, detail, payload_json
                 FROM events
                 WHERE event_id = ?",
                [&entry.event_id],
                |row| {
                    Ok(LiveEventRow {
                        workspace_id: row.get(0)?,
                        event_id: row.get(1)?,
                        kind: row.get(2)?,
                        subject_kind: row.get(3)?,
                        subject_id: row.get(4)?,
                        revision_id: row.get(5)?,
                        occurred_at: row.get(6)?,
                        observed_at: row.get(7)?,
                        headline: row.get(8)?,
                        detail: row.get(9)?,
                        payload_json: row.get(10)?,
                    })
                },
            )
            .ok();

        match live_event {
            None => {
                entry_ok = false;
                issues.push(LedgerAuditIssue {
                    code: "event_missing".to_owned(),
                    chain_seq: Some(entry.chain_seq),
                    event_id: Some(entry.event_id.clone()),
                    detail: format!(
                        "账本链节点 #{} 引用的关键决定事件 {} 已从 events 表被删除",
                        entry.chain_seq, entry.event_id
                    ),
                });
            }
            Some(ev) => {
                let snapshot = LedgerEventSnapshot {
                    workspace_id: &ev.workspace_id,
                    event_id: &ev.event_id,
                    kind: &ev.kind,
                    subject_kind: &ev.subject_kind,
                    subject_id: &ev.subject_id,
                    revision_id: ev.revision_id.as_deref(),
                    occurred_at: ev.occurred_at.as_deref(),
                    observed_at: &ev.observed_at,
                    headline: &ev.headline,
                    detail: &ev.detail,
                    payload_json: &ev.payload_json,
                };
                let recomputed_record = compute_event_record_hash(&snapshot);
                if recomputed_record != entry.record_hash
                    || ev.kind != entry.event_kind
                    || ev.subject_id != entry.subject_id
                    || ev.revision_id != entry.revision_id
                {
                    entry_ok = false;
                    issues.push(LedgerAuditIssue {
                        code: "event_content_tampered".to_owned(),
                        chain_seq: Some(entry.chain_seq),
                        event_id: Some(entry.event_id.clone()),
                        detail: format!(
                            "关键事件 {}（{}）内容与账本封存摘要不一致（重算 {}，封存 {}）",
                            entry.event_id,
                            entry.event_kind,
                            &recomputed_record[..16],
                            &entry.record_hash[..16.min(entry.record_hash.len())]
                        ),
                    });
                }

                // 若为 decision_writeback 且绑定了新版本，核验该修订行仍存在于 revisions 表
                if entry.event_kind == "decision_writeback" {
                    if let Some(ref rev_id) = entry.revision_id {
                        let rev_exists: i64 = conn
                            .query_row(
                                "SELECT EXISTS(SELECT 1 FROM revisions WHERE revision_id = ?)",
                                [rev_id],
                                |row| row.get(0),
                            )
                            .map_err(internal_sql)?;
                        if rev_exists == 0 {
                            entry_ok = false;
                            issues.push(LedgerAuditIssue {
                                code: "revision_missing".to_owned(),
                                chain_seq: Some(entry.chain_seq),
                                event_id: Some(entry.event_id.clone()),
                                detail: format!(
                                    "拍板回写事件 {} 绑定的落盘版本 {rev_id} 在 revisions 表中缺失",
                                    entry.event_id
                                ),
                            });
                        }
                    }
                }
            }
        }

        if entry_ok {
            verified_entries += 1;
        }
        expected_prev = entry.chain_hash.clone();
    }

    // 3. 核对 meta 链头锚点（防止同时截断链尾与事件尾）
    let meta_head_hash: Option<String> = conn
        .query_row(
            "SELECT value FROM meta WHERE key = ?",
            [META_LEDGER_HEAD_HASH],
            |row| row.get(0),
        )
        .ok();
    let meta_head_seq: Option<i64> = conn
        .query_row(
            "SELECT value FROM meta WHERE key = ?",
            [META_LEDGER_HEAD_SEQ],
            |row| row.get::<_, String>(0),
        )
        .ok()
        .and_then(|v| v.parse::<i64>().ok());

    let actual_last = chain_rows.last();
    match (actual_last, meta_head_hash.as_deref(), meta_head_seq) {
        (Some(last), Some(exp_hash), Some(exp_seq)) => {
            if last.chain_hash != exp_hash || last.chain_seq != exp_seq {
                issues.push(LedgerAuditIssue {
                    code: "head_mismatch".to_owned(),
                    chain_seq: Some(last.chain_seq),
                    event_id: Some(last.event_id.clone()),
                    detail: format!(
                        "账本链头与 meta 锚点不一致（期望 seq={exp_seq}/{}，实际 seq={}/{}）",
                        &exp_hash[..16.min(exp_hash.len())],
                        last.chain_seq,
                        &last.chain_hash[..16.min(last.chain_hash.len())]
                    ),
                });
            }
        }
        (None, Some(exp_hash), Some(exp_seq)) if exp_seq > 0 => {
            issues.push(LedgerAuditIssue {
                code: "head_mismatch".to_owned(),
                chain_seq: Some(exp_seq),
                event_id: None,
                detail: format!(
                    "账本链记录已被清空，但 meta 仍记录链头 seq={exp_seq}（{}）",
                    &exp_hash[..16.min(exp_hash.len())]
                ),
            });
        }
        _ => {}
    }

    // 4. 检测绕过账本链直接插入/伪造的关键决定事件
    let mut sealed_events_total: usize = 0;
    let first_sealed_event_seq: Option<i64> = conn
        .query_row(
            "SELECT MIN(event_seq) FROM decision_ledger_chain WHERE workspace_id = ?",
            [workspace_id],
            |row| row.get(0),
        )
        .ok()
        .flatten();
    let mut ev_stmt = conn
        .prepare(
            "SELECT seq, event_id, kind
             FROM events
             WHERE workspace_id = ?
             ORDER BY seq ASC",
        )
        .map_err(internal_sql)?;
    let ev_rows = ev_stmt
        .query_map([workspace_id], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })
        .map_err(internal_sql)?;
    for row in ev_rows {
        let (seq, event_id, kind) = row.map_err(internal_sql)?;
        if !is_ledger_sealed_kind(&kind) {
            continue;
        }
        sealed_events_total += 1;
        let must_be_sealed = match first_sealed_event_seq {
            Some(min_seq) => seq >= min_seq,
            None => meta_head_seq.is_some(),
        };
        if must_be_sealed && !sealed_event_ids.contains(&event_id) {
            issues.push(LedgerAuditIssue {
                code: "unsealed_decision_event".to_owned(),
                chain_seq: None,
                event_id: Some(event_id.clone()),
                detail: format!(
                    "关键事件 {event_id}（kind={kind}, seq={seq}）未登记在防篡改账本哈希链中"
                ),
            });
        }
    }

    Ok(LedgerAuditReport {
        ok: issues.is_empty(),
        table_present: true,
        verified_entries,
        sealed_events_total,
        head_chain_seq: actual_last.map(|r| r.chain_seq),
        head_chain_hash: actual_last.map(|r| r.chain_hash.clone()),
        issues,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn setup_mem_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
             CREATE TABLE revisions (revision_id TEXT PRIMARY KEY);
             CREATE TABLE events (
               seq INTEGER PRIMARY KEY AUTOINCREMENT,
               event_id TEXT NOT NULL UNIQUE,
               workspace_id TEXT NOT NULL,
               kind TEXT NOT NULL,
               subject_kind TEXT NOT NULL,
               subject_id TEXT NOT NULL,
               revision_id TEXT,
               occurred_at TEXT,
               occurred_precision TEXT NOT NULL DEFAULT 'second',
               occurred_source TEXT,
               observed_at TEXT NOT NULL,
               headline TEXT NOT NULL,
               detail TEXT NOT NULL,
               payload_json TEXT NOT NULL DEFAULT '{}',
               batch_id TEXT
             );
             CREATE TABLE decision_ledger_chain (
               chain_seq INTEGER PRIMARY KEY AUTOINCREMENT,
               workspace_id TEXT NOT NULL,
               event_id TEXT NOT NULL UNIQUE,
               event_seq INTEGER NOT NULL,
               event_kind TEXT NOT NULL,
               subject_id TEXT NOT NULL,
               revision_id TEXT,
               record_hash TEXT NOT NULL,
               prev_hash TEXT NOT NULL,
               chain_hash TEXT NOT NULL,
               sealed_at TEXT NOT NULL
             );",
        )
        .unwrap();
        conn
    }

    fn insert_and_seal(conn: &Connection, event_id: &str, kind: &str, detail: &str) {
        conn.execute(
            "INSERT INTO events (event_id, workspace_id, kind, subject_kind, subject_id, revision_id,
                occurred_at, observed_at, headline, detail, payload_json)
             VALUES (?, 'ws_1', ?, 'decision', 'dec_1', 'rev_1', '2026-11-21T10:00:00Z',
                     '2026-11-21T10:00:00Z', '拍板', ?, '{\"decision\":\"通过\"}')",
            params![event_id, kind, detail],
        )
        .unwrap();
        let seq = conn.last_insert_rowid();
        let ev = LedgerEventSnapshot {
            workspace_id: "ws_1",
            event_id,
            kind,
            subject_kind: "decision",
            subject_id: "dec_1",
            revision_id: Some("rev_1"),
            occurred_at: Some("2026-11-21T10:00:00Z"),
            observed_at: "2026-11-21T10:00:00Z",
            headline: "拍板",
            detail,
            payload_json: "{\"decision\":\"通过\"}",
        };
        seal_event_in_ledger(conn, seq, &ev).unwrap();
    }

    #[test]
    fn intact_chain_verifies_and_detects_all_tamper_modes() {
        let conn = setup_mem_db();
        conn.execute("INSERT INTO revisions (revision_id) VALUES ('rev_1')", [])
            .unwrap();
        insert_and_seal(&conn, "evt_1", "decision_writeback", "决定通过方案A");
        insert_and_seal(&conn, "evt_2", "proposal_adopted", "采纳草案 v2");

        let clean = verify_decision_ledger_on_conn(&conn, "ws_1").unwrap();
        assert!(clean.ok, "完好账本应验证通过：{:?}", clean.issues);
        assert_eq!(clean.verified_entries, 2);

        // 篡改模式 1：修改 events.detail
        conn.execute(
            "UPDATE events SET detail = '决定通过方案B（被篡改）' WHERE event_id = 'evt_1'",
            [],
        )
        .unwrap();
        let tampered = verify_decision_ledger_on_conn(&conn, "ws_1").unwrap();
        assert!(!tampered.ok);
        assert!(tampered
            .issues
            .iter()
            .any(|i| i.code == "event_content_tampered"));

        // 还原事件，测试篡改模式 2：绕过账本伪造未封存事件
        conn.execute(
            "UPDATE events SET detail = '决定通过方案A' WHERE event_id = 'evt_1'",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO events (event_id, workspace_id, kind, subject_kind, subject_id, revision_id,
                occurred_at, observed_at, headline, detail, payload_json)
             VALUES ('evt_forged', 'ws_1', 'decision_writeback', 'decision', 'dec_x', 'rev_1',
                     '2026-11-21T11:00:00Z', '2026-11-21T11:00:00Z', '伪造', '伪造决定', '{}')",
            [],
        )
        .unwrap();
        let forged = verify_decision_ledger_on_conn(&conn, "ws_1").unwrap();
        assert!(!forged.ok);
        assert!(forged
            .issues
            .iter()
            .any(|i| i.code == "unsealed_decision_event"
                && i.event_id.as_deref() == Some("evt_forged")));

        // 清理伪造行，测试篡改模式 3：截断链尾（链尾与 meta 锚点冲突）
        conn.execute("DELETE FROM events WHERE event_id = 'evt_forged'", [])
            .unwrap();
        conn.execute(
            "DELETE FROM decision_ledger_chain WHERE event_id = 'evt_2'",
            [],
        )
        .unwrap();
        let truncated = verify_decision_ledger_on_conn(&conn, "ws_1").unwrap();
        assert!(!truncated.ok);
        assert!(truncated.issues.iter().any(|i| i.code == "head_mismatch"));
    }
}
