//! 分页游标编解码与筛选指纹（契约 native/docs/contract-query-api.md §0.3）。
//!
//! 与 Node 现行为逐字对齐（server/queries.ts:76-114）：
//! - 游标载体：不透明 base64url(JSON)；
//! - 事件游标 `{snap, k, s, fp}`：k=本页最后一行的排序键，s=该行 seq，
//!   键集分页条件 `(k', s') < (k, s)`；
//! - 指纹 fp：对筛选参数集做 SHA-256 取 16 hex，续页请求参数集必须逐项一致。
//!
//! v1 差异（契约 §0.2）：游标不可解码在 Node 现状是静默回首页
//! （queries.ts:186-187），v1 改为显式 409 `CURSOR_STALE`；指纹不符现状抛
//! `INDEX_STALE`（queries.ts:189-195），v1 拆给 `CURSOR_STALE`。
//!
//! 新增端点（files/decisions/版本链）的游标沿用同一 JSON 形状：`snap` 换为
//! 签发时的 index_generation，`s` 为键集第二键（字符串）。

use sha2::{Digest, Sha256};

use crate::error::GuanlanError;
use crate::query::{DecisionsQuery, EventOrder, EventQuery, FileListQuery, RevisionOrder};

/// base64url 字母表（RFC 4648 §5，无填充——与 Node `Buffer.toString('base64url')` 一致）
const B64URL: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

pub(crate) fn b64url_encode(data: &[u8]) -> String {
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(B64URL[(n >> 18) as usize & 63] as char);
        out.push(B64URL[(n >> 12) as usize & 63] as char);
        if chunk.len() > 1 {
            out.push(B64URL[(n >> 6) as usize & 63] as char);
        }
        if chunk.len() > 2 {
            out.push(B64URL[n as usize & 63] as char);
        }
    }
    out
}

pub(crate) fn b64url_decode(raw: &str) -> Option<Vec<u8>> {
    let mut acc: u32 = 0;
    let mut bits: u32 = 0;
    let mut out = Vec::with_capacity(raw.len() / 4 * 3);
    for ch in raw.bytes() {
        let v = match ch {
            b'A'..=b'Z' => (ch - b'A') as u32,
            b'a'..=b'z' => (ch - b'a' + 26) as u32,
            b'0'..=b'9' => (ch - b'0' + 52) as u32,
            b'-' | b'+' => 62,
            b'_' | b'/' => 63,
            b'=' | b' ' | b'\t' | b'\r' | b'\n' => continue,
            _ => return None,
        };
        acc = (acc << 6) | v;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push(((acc >> bits) & 0xFF) as u8);
        }
    }
    Some(out)
}

/// 事件游标（契约 §0.3-2）。字段顺序与 Node `JSON.stringify({snap,k,s,fp})` 一致。
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct EventCursor {
    /// 签发时的窗口快照 max(events.seq)
    pub snap: i64,
    /// 本页最后一行的排序键（occurred 口径为 `occurred_at ?? ''`，observed 为 observed_at）
    pub k: String,
    /// 该行 seq
    pub s: i64,
    /// 筛选指纹
    pub fp: String,
}

/// 通用键集游标（files / decisions / 版本链等列表端点）。
/// `snap` 换为签发时的 index_generation；`s` 为键集第二键（字符串）。
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct KeyCursor {
    pub snap: i64,
    pub k: String,
    pub s: String,
    pub fp: String,
    /// 精确总数：版本链首页 COUNT 一次后随游标携带，续页不再重复
    /// COUNT 整条版本链；不含此字段的旧游标经 serde default 解码为 None，
    /// 续页回退现算。files/decisions 不使用，序列化时省略。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub total: Option<u64>,
}

/// 事件游标解码。失败时显式返回 `CURSOR_STALE`（409，见契约 §0.2，不静默回首页）。
pub fn decode_event_cursor(raw: &str) -> Result<EventCursor, GuanlanError> {
    let bytes = b64url_decode(raw).ok_or_else(cursor_stale_decode)?;
    let text = String::from_utf8(bytes).map_err(|_| cursor_stale_decode())?;
    serde_json::from_str(&text).map_err(|_| cursor_stale_decode())
}

/// 键集游标解码。失败 → `CURSOR_STALE`。
pub fn decode_key_cursor(raw: &str) -> Result<KeyCursor, GuanlanError> {
    let bytes = b64url_decode(raw).ok_or_else(cursor_stale_decode)?;
    let text = String::from_utf8(bytes).map_err(|_| cursor_stale_decode())?;
    serde_json::from_str(&text).map_err(|_| cursor_stale_decode())
}

pub fn encode_event_cursor(c: &EventCursor) -> String {
    b64url_encode(
        serde_json::to_string(c)
            .expect("事件游标序列化失败")
            .as_bytes(),
    )
}

pub fn encode_key_cursor(c: &KeyCursor) -> String {
    b64url_encode(
        serde_json::to_string(c)
            .expect("键集游标序列化失败")
            .as_bytes(),
    )
}

/// 偏移键游标（只读列表 `created_at` 倒序定长页的 OFFSET 载体）。
/// JSON {"o": offset} 的 base64url——结构简单且无代际语义（列表只追加，偏移安全）。
pub fn encode_key_cursor_offset(offset: u64) -> Option<String> {
    Some(b64url_encode(
        serde_json::to_string(&serde_json::json!({ "o": offset }))
            .ok()?
            .as_bytes(),
    ))
}

pub fn decode_key_cursor_offset(raw: &str) -> Result<i64, GuanlanError> {
    let bytes = b64url_decode(raw).ok_or_else(cursor_stale_decode)?;
    let text = String::from_utf8(bytes).map_err(|_| cursor_stale_decode())?;
    let value: serde_json::Value =
        serde_json::from_str(&text).map_err(|_| cursor_stale_decode())?;
    value
        .get("o")
        .and_then(|o| o.as_i64())
        .ok_or_else(cursor_stale_decode)
}

fn cursor_stale_decode() -> GuanlanError {
    GuanlanError::CursorStale("分页游标不可解码，请从第一页重新查询。".to_owned())
}

pub(crate) fn cursor_stale_fingerprint() -> GuanlanError {
    GuanlanError::CursorStale(
        "分页游标绑定的筛选条件与本次请求不一致，请从第一页重新查询。".to_owned(),
    )
}

pub(crate) fn cursor_stale_snapshot() -> GuanlanError {
    GuanlanError::CursorStale(
        "游标绑定的窗口快照已过期（索引有新提交），请从第一页重新查询。".to_owned(),
    )
}

fn sha256_16(input: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(input.as_bytes());
    hex::encode(hasher.finalize())[..16].to_owned()
}

pub(crate) fn non_empty(s: &Option<String>) -> Option<&str> {
    s.as_deref().filter(|v| !v.is_empty())
}

pub(crate) fn events_fingerprint(query: &EventQuery) -> String {
    #[derive(serde::Serialize)]
    struct Fp<'a> {
        from: Option<&'a str>,
        to: Option<&'a str>,
        kinds: Vec<&'a str>,
        format: Option<&'a str>,
        order: &'static str,
        undated: bool,
        q: Option<&'a str>,
    }
    let mut kinds: Vec<&str> = query.kinds.iter().map(String::as_str).collect();
    kinds.sort();
    let payload = Fp {
        from: non_empty(&query.from),
        to: non_empty(&query.to),
        kinds,
        format: non_empty(&query.format),
        order: query.order.as_str(),
        undated: query.undated,
        q: non_empty(&query.q),
    };
    sha256_16(&serde_json::to_string(&payload).expect("指纹序列化失败"))
}

pub(crate) fn files_fingerprint(query: &FileListQuery) -> String {
    #[derive(serde::Serialize)]
    struct Fp<'a> {
        dir: Option<&'a str>,
        format: Option<&'a str>,
        matter: Option<&'a str>,
        q: Option<&'a str>,
    }
    let payload = Fp {
        dir: non_empty(&query.dir),
        format: non_empty(&query.format),
        matter: non_empty(&query.matter),
        q: non_empty(&query.q),
    };
    let mut base = serde_json::to_string(&payload).expect("指纹序列化失败");
    if let Some(status) = non_empty(&query.status).filter(|s| *s != "active") {
        base.push_str("|status=");
        base.push_str(status);
    }
    sha256_16(&base)
}

pub(crate) fn decisions_fingerprint(query: &DecisionsQuery) -> String {
    #[derive(serde::Serialize)]
    struct Fp<'a> {
        status: Option<&'a str>,
        code: Option<&'a str>,
        q: Option<&'a str>,
    }
    let payload = Fp {
        status: non_empty(&query.status),
        code: non_empty(&query.code),
        q: non_empty(&query.q),
    };
    sha256_16(&serde_json::to_string(&payload).expect("指纹序列化失败"))
}

pub(crate) fn revisions_fingerprint(order: RevisionOrder) -> String {
    #[derive(serde::Serialize)]
    struct Fp {
        order: &'static str,
    }
    let payload = Fp {
        order: revisions_order_str(order),
    };
    sha256_16(&serde_json::to_string(&payload).expect("指纹序列化失败"))
}

pub(crate) fn revisions_order_str(order: RevisionOrder) -> &'static str {
    match order {
        RevisionOrder::SeqAsc => "seq_asc",
        RevisionOrder::SeqDesc => "seq_desc",
    }
}

impl EventOrder {
    pub fn as_str(&self) -> &'static str {
        match self {
            EventOrder::Occurred => "occurred",
            EventOrder::Observed => "observed",
        }
    }
}

pub(crate) fn clamp_limit(raw: Option<u32>, default: u32, max: u32) -> u32 {
    raw.unwrap_or(default).clamp(1, max)
}

pub(crate) fn local_day_expr(column: &str) -> String {
    format!("(CASE WHEN length({column}) <= 10 THEN {column} ELSE date({column}, 'localtime') END)")
}

pub(crate) fn safe_json(raw: &str) -> serde_json::Value {
    let text = if raw.is_empty() { "{}" } else { raw };
    match serde_json::from_str::<serde_json::Value>(text) {
        Ok(v @ serde_json::Value::Object(_)) => v,
        _ => serde_json::Value::Object(Default::default()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn b64url_matches_node_base64url() {
        assert_eq!(b64url_encode("hello 观澜".as_bytes()), "aGVsbG8g6KeC5r6c");
        assert_eq!(
            b64url_decode("aGVsbG8g6KeC5r6c").as_deref(),
            Some("hello 观澜".as_bytes())
        );
        assert_eq!(
            b64url_decode("aGVsbG8g6KeC5r6c==").as_deref(),
            Some("hello 观澜".as_bytes())
        );
        assert_eq!(b64url_decode("!!不是base64!!"), None);
    }

    #[test]
    fn event_cursor_roundtrip_and_corrupt() {
        let cursor = EventCursor {
            snap: 341,
            k: "2026-11-12T09:30:00.000Z".to_owned(),
            s: 320,
            fp: "0123456789abcdef".to_owned(),
        };
        let encoded = encode_event_cursor(&cursor);
        assert_eq!(decode_event_cursor(&encoded).expect("往返失败"), cursor);
        let node_style = b64url_encode(br#"{"snap":341,"k":"k","s":9,"fp":"fp"}"#);
        let decoded = decode_event_cursor(&node_style).expect("Node 风格游标解码失败");
        assert_eq!((decoded.snap, decoded.k.as_str(), decoded.s), (341, "k", 9));
        match decode_event_cursor("not-a-cursor") {
            Err(GuanlanError::CursorStale(_)) => {}
            other => panic!("损坏游标应报 CURSOR_STALE，实际 {other:?}"),
        }
    }

    #[test]
    fn events_fingerprint_order_and_shape() {
        let mut q = EventQuery {
            from: None,
            to: None,
            kinds: vec!["modified".to_owned(), "appeared".to_owned()],
            format: Some("md".to_owned()),
            order: EventOrder::Occurred,
            undated: false,
            q: Some(String::new()),
            limit: None,
            cursor: None,
        };
        assert_eq!(events_fingerprint(&q), "5b9571ad5ea150d4");
        q.kinds = vec!["appeared".to_owned(), "modified".to_owned()];
        assert_eq!(events_fingerprint(&q), "5b9571ad5ea150d4");
        q.undated = true;
        assert_ne!(events_fingerprint(&q), "5b9571ad5ea150d4");
        q.undated = false;
        q.q = Some("正文".to_owned());
        assert_ne!(events_fingerprint(&q), "5b9571ad5ea150d4");
    }

    #[test]
    fn local_day_expr_short_circuits_pure_dates() {
        let conn = rusqlite::Connection::open_in_memory().expect("内存库");
        let expr = local_day_expr("v");
        let one = |v: &str| -> String {
            conn.query_row(&format!("SELECT {expr} FROM (SELECT ? AS v)"), [v], |r| {
                r.get::<_, Option<String>>(0)
            })
            .expect("求值失败")
            .unwrap_or_default()
        };
        assert_eq!(one("2026-01-02"), "2026-01-02");
        let mixed = one("2026-01-02T23:30:00.000Z");
        assert_eq!(mixed.len(), 10, "localtime 取日应产出 YYYY-MM-DD：{mixed}");
        assert_eq!(mixed.as_bytes()[4], b'-');
    }
}
