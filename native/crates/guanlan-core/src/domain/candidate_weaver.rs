//! 多信号"隐式事项（Initiative）"候选编织器（纯函数核心，无 IO）。
//!
//! 综合四类信号把散落文件编织为带**可解释理由胶囊**的候选事项簇：
//! - `S1 目录前缀`：同目录下文件名主干共享编号/语义前缀；
//! - `S2 显式链接`：Markdown 显式引用边（`edges.kind = explicit_reference`，已解析目标）；
//! - `S3 同名主干`：跨目录同名主干（`方案.md` ↔ `方案-架构.svg`）；
//! - `S4 会话共现`：最新版本落库时刻相差 ≤ [`SESSION_WINDOW`] 分钟（同一活跃编辑会话）；
//! - `S5 Agent 批次`：同一 `batch_id` 产出（预留通道——当前管线恒空，命中即最高权重）。
//!
//! 算法：文件为节点、信号为带权无向边，并查集取连通分量；分量 ≥ [`MIN_MEMBERS`]
//! 才成候选。**每条关联都携带命中证据**（信号种类 + 人话描述），绝不黑盒打分。
//!
//! 红线：本模块只产出候选与证据，不移动磁盘文件、不写任何正式事项归属；
//! 采纳/剔除由用户经 HTTP 显式触发（采纳后由 `state_engine` 固化归属）。

use serde::Serialize;

/// 会话共现窗口（分钟）：判定同一活跃编辑会话的时间跨度
pub const SESSION_WINDOW_MIN: i64 = 45;
/// 候选簇最小成员数
pub const MIN_MEMBERS: usize = 2;
/// 候选簇成员上限（显式链接链式传染的保险丝；超限簇本轮弃置）
pub const MAX_MEMBERS: usize = 24;

pub const SIG_DIR_PREFIX: u32 = 0x01;
pub const SIG_LINK: u32 = 0x02;
pub const SIG_SAME_STEM: u32 = 0x04;
pub const SIG_SESSION: u32 = 0x08;
pub const SIG_AGENT_BATCH: u32 = 0x10;

/// 编织输入：文件信号（来自 `files` + 最新 revision 的库内行，收集侧组装）
#[derive(Debug, Clone)]
pub struct WeaverFile {
    pub file_id: String,
    /// 正斜杠相对路径
    pub path: String,
    pub title: String,
    /// 文件最后修改时刻（mtime 毫秒；会话共现信号用——落库时刻在冷启动全同，失真）
    pub activity_ms: Option<i64>,
    /// 产出批次（当前管线恒 None；命中即 S5 最高权重）
    pub batch_id: Option<String>,
}

/// 编织输入：已解析的显式引用边（`resolution != unresolved`）
#[derive(Debug, Clone)]
pub struct WeaverEdge {
    pub source_file_id: String,
    pub target_file_id: String,
}

/// 单成员的理由胶囊明细（wire：`signals` 数组元素）
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct MemberSignal {
    /// dir_prefix | link | same_stem | session | agent_batch
    pub signal: &'static str,
    /// 人话证据（悬浮展示，非黑盒）
    pub detail: String,
}

/// 候选成员（`signals_json` 序列化 [`MemberSignal`] 数组）
#[derive(Debug, Clone, Serialize)]
pub struct CandidateMember {
    pub file_id: String,
    pub signals: Vec<MemberSignal>,
}

/// 产出：候选事项簇（落库侧组装 `initiative_candidates` 行）
#[derive(Debug, Clone, Serialize)]
pub struct CandidateCluster {
    /// 结构化簇键（排序成员 file_id 的 sha 前 16）——排除表按它"重扫不反弹"
    pub candidate_key: String,
    /// 建议事项名（簇内最长文件名主干）
    pub title: String,
    /// 主理由胶囊（人话一句话）
    pub reason_summary: String,
    /// 信号位掩码（S1|S2|S3|S4|S5）
    pub signal_mask: u32,
    /// 置信分 0-100
    pub score: u32,
    pub members: Vec<CandidateMember>,
}

/// 文件名主干：去扩展名 → 去两位编号前缀（`01-`）→ 去尾部版本/变体段
/// （`-v2` / `_final` / `-架构` / `-3`）。返回小写规范形，供 S1/S3 比对。
pub fn stem_of(file_name: &str) -> String {
    let no_ext = match file_name.rfind('.') {
        Some(0) | None => file_name,
        Some(idx) => &file_name[..idx],
    };
    let mut stem = no_ext.trim().to_ascii_lowercase();
    let bytes = stem.as_bytes();
    if bytes.len() >= 3
        && bytes[0].is_ascii_digit()
        && bytes[1].is_ascii_digit()
        && bytes[2] == b'-'
    {
        stem = stem[3..].to_owned();
    }
    if stem.chars().count() > 1 {
        if let Some(idx) = stem.rfind(['-', '_']) {
            if idx > 0 {
                let tail = &stem[idx + 1..];
                let all_digits = !tail.is_empty() && tail.chars().all(|c| c.is_ascii_digit());
                let v_version = tail.len() >= 2
                    && tail.starts_with('v')
                    && tail[1..].chars().all(|c| c.is_ascii_digit());
                let known_word = matches!(tail, "final" | "draft" | "new" | "old" | "copy");
                let prefix_is_code = {
                    let head = &stem[..idx];
                    !head.is_empty()
                        && head.len() <= 6
                        && head.chars().all(|c| c.is_ascii_alphanumeric())
                        && head.chars().last().is_some_and(|c| c.is_ascii_digit())
                };
                let cjk_variant =
                    stem.as_bytes().get(idx) == Some(&b'-') && !tail.is_ascii() && !prefix_is_code;
                if all_digits || v_version || known_word || cjk_variant {
                    stem.truncate(idx);
                }
            }
        }
    }
    stem
}

fn minutes_between(a_ms: i64, b_ms: i64) -> i64 {
    (a_ms - b_ms).abs() / 60_000
}

struct UnionFind {
    parent: Vec<usize>,
}

impl UnionFind {
    fn new(n: usize) -> Self {
        Self {
            parent: (0..n).collect(),
        }
    }
    fn find(&mut self, x: usize) -> usize {
        if self.parent[x] != x {
            let root = self.find(self.parent[x]);
            self.parent[x] = root;
        }
        self.parent[x]
    }
    fn union(&mut self, a: usize, b: usize) {
        let (ra, rb) = (self.find(a), self.find(b));
        if ra != rb {
            self.parent[ra] = rb;
        }
    }
}

/// 编织候选簇。`keys` 为簇键哈希函数（注入 `stable_key`，保持 domain 身份纪律单一出口）。
pub fn weave_candidates(
    files: &[WeaverFile],
    edges: &[WeaverEdge],
    stable_key: impl Fn(&str) -> String,
    excluded_pairs: &std::collections::HashSet<(String, String)>,
) -> Vec<CandidateCluster> {
    let n = files.len();
    if n < MIN_MEMBERS {
        return Vec::new();
    }
    let index_of: HashMap<&str, usize> = files
        .iter()
        .enumerate()
        .map(|(i, f)| (f.file_id.as_str(), i))
        .collect();

    let is_cut = |a: usize, b: usize| -> bool {
        let (x, y) = (&files[a].file_id, &files[b].file_id);
        if x <= y {
            excluded_pairs.contains(&(x.clone(), y.clone()))
        } else {
            excluded_pairs.contains(&(y.clone(), x.clone()))
        }
    };

    let mut link_signals: Vec<Vec<MemberSignal>> = vec![Vec::new(); n];
    let mut uf = UnionFind::new(n);

    for edge in edges {
        if let (Some(&a), Some(&b)) = (
            index_of.get(edge.source_file_id.as_str()),
            index_of.get(edge.target_file_id.as_str()),
        ) {
            if a != b && !is_cut(a, b) {
                let source_title = files[a].title.clone();
                link_signals[b].push(MemberSignal {
                    signal: "link",
                    detail: format!("被「{source_title}」显式引用"),
                });
                link_signals[a].push(MemberSignal {
                    signal: "link",
                    detail: format!("显式引用「{}」", files[b].title),
                });
                uf.union(a, b);
            }
        }
    }

    let mut stems: HashMap<String, Vec<usize>> = HashMap::new();
    for (i, file) in files.iter().enumerate() {
        let name = file
            .path
            .rsplit_once('/')
            .map(|(_, n)| n)
            .unwrap_or(&file.path);
        let stem = stem_of(name);
        if stem.chars().count() >= 2 {
            stems.entry(stem).or_default().push(i);
        }
    }
    for (stem, group) in &stems {
        if group.len() >= MIN_MEMBERS && group.len() <= MAX_MEMBERS {
            for &i in group {
                link_signals[i].push(MemberSignal {
                    signal: "same_stem",
                    detail: format!("共享同名主干「{stem}」"),
                });
            }
            for pair in group.windows(2) {
                if !is_cut(pair[0], pair[1]) {
                    uf.union(pair[0], pair[1]);
                }
            }
        }
    }

    let mut by_time: Vec<usize> = (0..n).collect();
    by_time.sort_by_key(|&i| files[i].activity_ms.unwrap_or(i64::MAX));
    for w in by_time.windows(2) {
        let (a, b) = (w[0], w[1]);
        if let (Some(ta), Some(tb)) = (files[a].activity_ms, files[b].activity_ms) {
            let diff = minutes_between(ta, tb);
            if diff <= SESSION_WINDOW_MIN && !is_cut(a, b) {
                link_signals[a].push(MemberSignal {
                    signal: "session",
                    detail: format!("最后修改相差 {diff} 分钟（同一编辑会话）"),
                });
                link_signals[b].push(MemberSignal {
                    signal: "session",
                    detail: format!("最后修改相差 {diff} 分钟（同一编辑会话）"),
                });
                uf.union(a, b);
            }
        }
    }

    let mut batches: HashMap<&str, Vec<usize>> = HashMap::new();
    for (i, file) in files.iter().enumerate() {
        if let Some(batch) = file.batch_id.as_deref() {
            if !batch.is_empty() {
                batches.entry(batch).or_default().push(i);
            }
        }
    }
    for group in batches.values() {
        if group.len() >= MIN_MEMBERS {
            for &i in group {
                link_signals[i].push(MemberSignal {
                    signal: "agent_batch",
                    detail: format!(
                        "同一智能体批次产出（{})",
                        files[i].batch_id.as_deref().unwrap_or("")
                    ),
                });
                uf.union(*group.first().expect("组非空"), i);
            }
        }
    }

    let mut components: HashMap<usize, Vec<usize>> = HashMap::new();
    for i in 0..n {
        components.entry(uf.find(i)).or_default().push(i);
    }

    let mut out: Vec<CandidateCluster> = components
        .into_values()
        .filter(|members| members.len() >= MIN_MEMBERS && members.len() <= MAX_MEMBERS)
        .map(|members| {
            let mut dir_signals: HashMap<&str, Vec<usize>> = HashMap::new();
            for &i in &members {
                let dir = files[i].path.rsplit_once('/').map(|(d, _)| d).unwrap_or("");
                dir_signals.entry(dir).or_default().push(i);
            }
            for group in dir_signals.values() {
                if group.len() < MIN_MEMBERS {
                    continue;
                }
                let stems: Vec<String> = group
                    .iter()
                    .map(|&i| {
                        let name = files[i]
                            .path
                            .rsplit_once('/')
                            .map(|(_, n)| n)
                            .unwrap_or(&files[i].path);
                        stem_of(name)
                    })
                    .collect();
                let prefix = common_prefix(&stems);
                if prefix.chars().count() >= 2 {
                    for &i in group {
                        link_signals[i].push(MemberSignal {
                            signal: "dir_prefix",
                            detail: format!("同目录共享前缀「{prefix}」"),
                        });
                    }
                }
            }

            let mut signal_mask = 0u32;
            let mut members_out: Vec<CandidateMember> = Vec::new();
            let mut link_edge_count = 0usize;
            for &i in &members {
                let mut signals = link_signals[i].clone();
                signals.sort_by(|a, b| a.signal.cmp(b.signal).then(a.detail.cmp(&b.detail)));
                signals.dedup();
                for s in &signals {
                    signal_mask |= match s.signal {
                        "dir_prefix" => SIG_DIR_PREFIX,
                        "link" => SIG_LINK,
                        "same_stem" => SIG_SAME_STEM,
                        "session" => SIG_SESSION,
                        "agent_batch" => SIG_AGENT_BATCH,
                        _ => 0,
                    };
                    if s.signal == "link" {
                        link_edge_count += 1;
                    }
                }
                members_out.push(CandidateMember {
                    file_id: files[i].file_id.clone(),
                    signals,
                });
            }

            let kinds = signal_mask.count_ones();
            let score =
                (kinds * 18 + members_out.len() as u32 * 5 + link_edge_count as u32 * 3).min(100);

            let title = members
                .iter()
                .map(|&i| {
                    let name = files[i]
                        .path
                        .rsplit_once('/')
                        .map(|(_, n)| n)
                        .unwrap_or(&files[i].path);
                    name.rsplit_once('.')
                        .filter(|(stem, _)| !stem.is_empty())
                        .map(|(stem, _)| stem)
                        .unwrap_or(name)
                })
                .max_by(|a, b| a.chars().count().cmp(&b.chars().count()).then(b.cmp(a)))
                .unwrap_or("未命名事项")
                .to_owned();

            let reason_summary = if signal_mask & SIG_AGENT_BATCH != 0 {
                "同一智能体批次产出，命中批次共现信号".to_owned()
            } else if signal_mask & SIG_LINK != 0 {
                format!("{} 份文件存在显式交叉引用，命中链接信号", members_out.len())
            } else if signal_mask & SIG_SAME_STEM != 0 {
                "多份文件共享同名主干（同一主题的不同形态），命中同名信号".to_owned()
            } else if signal_mask & SIG_SESSION != 0 {
                format!(
                    "{} 份文件在 {} 分钟内先后修改，命中会话共现信号",
                    members_out.len(),
                    SESSION_WINDOW_MIN
                )
            } else {
                "同目录下共享命名前缀，命中目录前缀信号".to_owned()
            };

            let mut sorted_ids: Vec<&str> =
                members.iter().map(|&i| files[i].file_id.as_str()).collect();
            sorted_ids.sort_unstable();
            let candidate_key = stable_key(&sorted_ids.join("|"));

            CandidateCluster {
                candidate_key,
                title,
                reason_summary,
                signal_mask,
                score,
                members: members_out,
            }
        })
        .collect();

    out.sort_by(|a, b| b.score.cmp(&a.score).then(a.title.cmp(&b.title)));
    out
}

fn common_prefix(stems: &[String]) -> String {
    if stems.is_empty() {
        return String::new();
    }
    let first = &stems[0];
    let mut len = 0usize;
    'outer: for (ci, ch) in first.char_indices() {
        for other in &stems[1..] {
            match other.get(ci..) {
                Some(rest) if rest.starts_with(ch) => {}
                _ => break 'outer,
            }
        }
        len = ci + ch.len_utf8();
    }
    first[..len].to_owned()
}

use std::collections::HashMap;

#[cfg(test)]
mod tests {
    use super::*;

    fn file(id: &str, path: &str, activity_ms: Option<i64>) -> WeaverFile {
        let title = path.rsplit('/').next().unwrap_or(path).to_owned();
        WeaverFile {
            file_id: id.to_owned(),
            path: path.to_owned(),
            title,
            activity_ms,
            batch_id: None,
        }
    }

    fn no_cuts() -> std::collections::HashSet<(String, String)> {
        std::collections::HashSet::new()
    }

    fn ids(clusters: &[CandidateCluster]) -> Vec<Vec<&str>> {
        clusters
            .iter()
            .map(|c| c.members.iter().map(|m| m.file_id.as_str()).collect())
            .collect()
    }

    #[test]
    fn stem_strips_number_prefix_and_variant_tail() {
        assert_eq!(stem_of("01-登录方案.md"), "登录方案");
        assert_eq!(stem_of("方案-架构.svg"), "方案");
        assert_eq!(stem_of("方案.md"), "方案");
        assert_eq!(stem_of("BOM_v2.xlsx"), "bom");
        assert_eq!(stem_of("Q01-决策记录.md"), "q01-决策记录");
        assert_eq!(stem_of("回执-3.docx"), "回执");
    }

    #[test]
    fn scattered_across_four_dirs_cluster_via_stem_and_session() {
        let files = vec![
            file("f1", "方案/总体/登录方案.md", Some(1_742_700_000_000)),
            file("f2", "设计/图纸/登录方案-架构.svg", Some(1_742_700_720_000)),
            file(
                "f3",
                "交付/清单/登录方案-验收清单.docx",
                Some(1_742_700_000_000 + 1_800_000),
            ),
            file(
                "f4",
                "需求/提案/登录方案-需求蓝图.md",
                Some(1_742_700_000_000 + 2_460_000),
            ),
            file("f9", "随记/周报.md", Some(1_742_700_000_000 - 3_600_000)),
        ];
        let clusters = weave_candidates(&files, &[], |s| format!("k_{s}"), &no_cuts());
        let got = ids(&clusters);
        assert!(
            got.contains(&vec!["f1", "f2", "f3", "f4"]),
            "四目录散落文件应聚成一簇，实得 {got:?}"
        );
        let cluster = clusters
            .iter()
            .find(|c| c.members.len() == 4)
            .expect("存在 4 成员簇");
        for member in &cluster.members {
            assert!(
                !member.signals.is_empty(),
                "成员 {} 应携带理由胶囊",
                member.file_id
            );
            assert!(member.signals.iter().any(|s| s.signal == "same_stem"));
        }
        assert_eq!(cluster.title, "登录方案-需求蓝图");
        assert!(cluster.score > 0);
    }

    #[test]
    fn explicit_link_merges_clusters_and_carry_evidence() {
        let files = vec![
            file("a1", "docs/bom.xlsx", Some(1_742_700_000_000 - 3_600_000)),
            file("a2", "specs/plan.md", Some(1_742_700_000_000 + 3_600_000)),
        ];
        let edges = vec![WeaverEdge {
            source_file_id: "a2".to_owned(),
            target_file_id: "a1".to_owned(),
        }];
        let clusters = weave_candidates(&files, &edges, |s| format!("k_{s}"), &no_cuts());
        assert_eq!(clusters.len(), 1);
        let plan_member = clusters[0]
            .members
            .iter()
            .find(|m| m.file_id == "a2")
            .expect("plan 成员");
        assert!(
            plan_member
                .signals
                .iter()
                .any(|s| s.signal == "link" && s.detail.contains("bom")),
            "链接证据应写明对端文件：{:?}",
            plan_member.signals
        );
    }

    #[test]
    fn session_window_binds_nearby_edits_only() {
        let files = vec![
            file("t1", "notes/a.md", Some(1_742_700_000_000)),
            file("t2", "notes/b.md", Some(1_742_700_000_000 + 1_200_000)),
            file("t3", "other/c.md", Some(1_742_700_000_000 + 28_800_000)),
        ];
        let clusters = weave_candidates(&files, &[], |s| format!("k_{s}"), &no_cuts());
        let got = ids(&clusters);
        assert!(
            got.contains(&vec!["t1", "t2"]),
            "45 分钟窗口内应成簇 {got:?}"
        );
        assert!(
            !got.iter().any(|c| c.contains(&"t3")),
            "8 小时差不入簇 {got:?}"
        );
    }

    #[test]
    fn candidate_key_is_stable_across_input_order() {
        let files_a = vec![
            file("x1", "p/部署方案.md", None),
            file("x2", "p/部署方案-架构.svg", None),
        ];
        let files_b = vec![
            file("x2", "p/部署方案-架构.svg", None),
            file("x1", "p/部署方案.md", None),
        ];
        let ka = weave_candidates(&files_a, &[], |s| format!("k_{s}"), &no_cuts());
        let kb = weave_candidates(&files_b, &[], |s| format!("k_{s}"), &no_cuts());
        assert_eq!(
            ka[0].candidate_key, kb[0].candidate_key,
            "同簇跨顺序键稳定（排除表前提）"
        );
    }

    #[test]
    fn excluded_pair_cuts_member_out_and_rescan_does_not_rebound() {
        let files = vec![
            file("c1", "docs/登录方案.md", Some(1_742_700_000_000)),
            file(
                "c2",
                "specs/登录方案-架构.svg",
                Some(1_742_700_000_000 + 600_000),
            ),
            file(
                "c3",
                "misc/登录方案-误聚.md",
                Some(1_742_700_000_000 + 1_200_000),
            ),
        ];
        let cuts = std::collections::HashSet::from([
            ("c1".to_owned(), "c3".to_owned()),
            ("c2".to_owned(), "c3".to_owned()),
        ]);
        let clusters = weave_candidates(&files, &[], |s| format!("k_{s}"), &cuts);
        let got = ids(&clusters);
        assert!(
            got.contains(&vec!["c1", "c2"]),
            "未剔除的两人应保持成簇 {got:?}"
        );
        assert!(
            !got.iter().any(|c| c.contains(&"c3")),
            "被剔除成员不得反弹进簇 {got:?}"
        );
    }

    #[test]
    fn oversize_component_is_dropped_not_emitted() {
        let mut files: Vec<WeaverFile> = (0..40)
            .map(|i| {
                file(
                    &format!("m{i}"),
                    &format!("docs/01-专项/page{i}.md"),
                    Some(1_742_700_000_000),
                )
            })
            .collect();
        files.push(file(
            "solo",
            "misc/独立笔记.md",
            Some(1_742_700_000_000 - 93_600_000),
        ));
        let clusters = weave_candidates(&files, &[], |s| format!("k_{s}"), &no_cuts());
        assert!(
            !clusters.iter().any(|c| c.members.len() > MAX_MEMBERS),
            "超限簇弃置（保险丝）"
        );
    }
}
