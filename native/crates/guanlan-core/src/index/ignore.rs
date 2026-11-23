//! `.gitignore` 解析与匹配（B01 · 采集白名单放开后的忽略纪律）。
//!
//! B01 放开采集白名单后，「工作区内什么算资料」由两条规则共同决定：
//!
//! 1. **系统/依赖目录黑名单**（[`crate::index::collector::DEFAULT_EXCLUDED`]）：
//!    `node_modules` / `.git` / `target` / `__pycache__` 等——这些目录里的东西
//!    不是用户的资料，是构建产物或依赖缓存。
//! 2. **`.gitignore`**：用户在仓库里亲手声明过的忽略规则。尊重它是「不擅自
//!    猜测用户意图」的底线——被 ignore 的构建产物、大模型权重、临时缓存不该
//!    混进时间主干。
//!
//! 实现对齐 git 的语义要点：
//!
//! - 逐目录读取：根目录与**每一层子目录**的 `.gitignore` 都生效，规则按
//!   「越深越优先」结算（最后命中的规则说了算）。
//! - `!` 取反、`#` 注释、空行忽略、`\` 转义。
//! - 尾部 `/` = 仅目录；含 `/`（或以 `/` 开头）的模式锚定在规则所在目录，
//!   否则匹配任意层级的同名项。
//! - `*` 不跨 `/`、`?` 匹配单字符、`**` 跨目录、`[abc]` / `[a-z]` 字符类。
//!
//! **不实现**的 git 细节（刻意取舍，避免过度工程）：`\` 之外的完整转义体系、
//! `core.excludesFile` 全局忽略、`.git/info/exclude`、索引内的忽略规则。
//! 这些只影响「少看几个文件」，不会造成错误入库。

/// 单条忽略规则。
#[derive(Debug, Clone)]
pub struct IgnoreRule {
    /// 规则所在目录（相对工作区根，正斜杠；根目录为 `""`）。
    base: String,
    /// 去尾部 `/` 后的 glob 模式（不含前导 `/`）。
    pattern: String,
    /// 仅对目录生效（模式尾部是 `/`）。
    dir_only: bool,
    /// 取反规则（模式以 `!` 开头）。
    negated: bool,
    /// 锚定在规则所在目录（模式含 `/` 或以 `/` 开头）。
    anchored: bool,
}

impl IgnoreRule {
    /// 规则是否命中给定路径。
    fn matches(&self, rel_path: &str, is_dir: bool) -> bool {
        if self.dir_only && !is_dir {
            return false;
        }
        let relative = if self.base.is_empty() {
            rel_path
        } else {
            let prefix = format!("{}/", self.base);
            match rel_path.strip_prefix(prefix.as_str()) {
                Some(rest) => rest,
                None => return false,
            }
        };
        if relative.is_empty() {
            return false;
        }
        if self.anchored {
            glob_match_path(&self.pattern, relative)
        } else {
            let name = relative.rsplit('/').next().unwrap_or(relative);
            glob_match_segment(&self.pattern, name)
        }
    }
}

/// 一组忽略规则（通常是某个目录下的 `.gitignore` 解析结果）。
#[derive(Debug, Clone, Default)]
pub struct Gitignore {
    rules: Vec<IgnoreRule>,
}

impl Gitignore {
    /// 解析一份 `.gitignore` 内容。`base` 是该文件所在目录（相对工作区根）。
    pub fn parse(base: &str, content: &str) -> Self {
        let mut rules = Vec::new();
        for raw_line in content.lines() {
            let line = raw_line.trim_end_matches('\r');
            let line = trim_trailing_spaces(line);
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            let mut pattern = line.to_owned();
            let mut negated = false;
            if let Some(rest) = pattern.strip_prefix('!') {
                negated = true;
                pattern = rest.to_owned();
            }
            // 转义的首字符（`\!` / `\#`）按字面量处理
            if pattern.starts_with('\\') && pattern.len() > 1 {
                pattern = pattern[1..].to_owned();
            }
            let mut dir_only = false;
            if pattern.ends_with('/') {
                dir_only = true;
                pattern.pop();
            }
            if pattern.is_empty() {
                continue;
            }
            let anchored = pattern.contains('/');
            let pattern = pattern.strip_prefix('/').unwrap_or(&pattern).to_owned();
            rules.push(IgnoreRule {
                base: base.to_owned(),
                pattern,
                dir_only,
                negated,
                anchored,
            });
        }
        Self { rules }
    }

    /// 规则是否为空（空则整个工作区不做 `.gitignore` 过滤）。
    pub fn is_empty(&self) -> bool {
        self.rules.is_empty()
    }

    /// 规则只读视图（B05：collector 缓存命中时按既有规则重建实例，避免重复读盘解析）。
    pub fn rules(&self) -> &[IgnoreRule] {
        &self.rules
    }

    /// 由既有规则集重建实例（[`Self::rules`] 的逆操作；`base` 语义已编码在每条规则内）。
    pub fn from_rules(rules: Vec<IgnoreRule>) -> Self {
        Self { rules }
    }

    /// 判定路径是否被忽略。**最后命中的规则说了算**（越深的规则越晚加入，
    /// 因此越深越优先——与 git 一致）。
    pub fn is_ignored(&self, rel_path: &str, is_dir: bool) -> bool {
        let mut ignored = false;
        for rule in &self.rules {
            if rule.matches(rel_path, is_dir) {
                ignored = !rule.negated;
            }
        }
        ignored
    }
}

/// 忽略规则栈：父目录规则在前、子目录规则在后（后者优先）。
#[derive(Debug, Clone, Default)]
pub struct IgnoreStack {
    layers: Vec<Gitignore>,
}

impl IgnoreStack {
    /// 压入一层规则（进入某个目录时）。仅非空层入栈；返回是否实际入栈，
    /// 调用方据此决定离开目录时是否 `pop`，避免子目录空 `.gitignore` 误弹父层。
    pub fn push(&mut self, layer: Gitignore) -> bool {
        if layer.is_empty() {
            return false;
        }
        self.layers.push(layer);
        true
    }

    /// 弹出最近压入的一层（离开某个目录时）。
    pub fn pop(&mut self) {
        if let Some(layer) = self.layers.pop() {
            // 只有非空层才会被 push，因此这里总能弹出
            let _ = layer;
        }
    }

    /// 判定路径是否被忽略（遍历所有层，最后命中者说了算）。
    pub fn is_ignored(&self, rel_path: &str, is_dir: bool) -> bool {
        let mut ignored = false;
        for layer in &self.layers {
            for rule in &layer.rules {
                if rule.matches(rel_path, is_dir) {
                    ignored = !rule.negated;
                }
            }
        }
        ignored
    }

    /// 栈是否为空。
    pub fn is_empty(&self) -> bool {
        self.layers.is_empty()
    }
}

/// 去掉行尾未被转义的空间（git 语义）
fn trim_trailing_spaces(line: &str) -> &str {
    let bytes = line.as_bytes();
    let mut end = bytes.len();
    while end > 0 && bytes[end - 1] == b' ' {
        // 前一个字符是反斜杠 → 空格被转义，停止
        if end >= 2 && bytes[end - 2] == b'\\' {
            break;
        }
        end -= 1;
    }
    &line[..end]
}

/// 路径级 glob 匹配（支持 `**` 跨目录）。
pub fn glob_match_path(pattern: &str, path: &str) -> bool {
    let pattern_segments: Vec<&str> = pattern.split('/').collect();
    let path_segments: Vec<&str> = path.split('/').collect();
    match_path_segments(&pattern_segments, &path_segments)
}

fn match_path_segments(pattern: &[&str], path: &[&str]) -> bool {
    if pattern.is_empty() {
        return path.is_empty();
    }
    if pattern[0] == "**" {
        // `**` 匹配零个或多个路径段
        for skip in 0..=path.len() {
            if match_path_segments(&pattern[1..], &path[skip..]) {
                return true;
            }
        }
        return false;
    }
    if path.is_empty() {
        return false;
    }
    if !glob_match_segment(pattern[0], path[0]) {
        return false;
    }
    match_path_segments(&pattern[1..], &path[1..])
}

/// 单路径段 glob 匹配：`*`（不跨 `/`）、`?`、`[abc]` / `[a-z]` / `[!abc]`。
pub fn glob_match_segment(pattern: &str, text: &str) -> bool {
    let p: Vec<char> = pattern.chars().collect();
    let t: Vec<char> = text.chars().collect();
    match_segment(&p, 0, &t, 0)
}

fn match_segment(p: &[char], mut pi: usize, t: &[char], mut ti: usize) -> bool {
    while pi < p.len() {
        match p[pi] {
            '*' => {
                // 尝试吞掉 0..=剩余长度
                for skip in ti..=t.len() {
                    if match_segment(p, pi + 1, t, skip) {
                        return true;
                    }
                }
                return false;
            }
            '?' => {
                if ti >= t.len() {
                    return false;
                }
                pi += 1;
                ti += 1;
            }
            '[' => {
                let Some(close) = (pi + 1..p.len()).find(|&idx| p[idx] == ']') else {
                    // 未闭合的 `[` 按字面量处理
                    if ti >= t.len() || t[ti] != '[' {
                        return false;
                    }
                    pi += 1;
                    ti += 1;
                    continue;
                };
                if ti >= t.len() {
                    return false;
                }
                let negated = matches!(p.get(pi + 1), Some('!') | Some('^'));
                let body_start = if negated { pi + 2 } else { pi + 1 };
                let mut matched = false;
                let mut idx = body_start;
                while idx < close {
                    if idx + 2 < close && p[idx + 1] == '-' {
                        if t[ti] >= p[idx] && t[ti] <= p[idx + 2] {
                            matched = true;
                        }
                        idx += 3;
                    } else {
                        if t[ti] == p[idx] {
                            matched = true;
                        }
                        idx += 1;
                    }
                }
                if matched == negated {
                    return false;
                }
                pi = close + 1;
                ti += 1;
            }
            c => {
                if ti >= t.len() || t[ti] != c {
                    return false;
                }
                pi += 1;
                ti += 1;
            }
        }
    }
    ti == t.len()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plain_name_matches_any_depth() {
        let gi = Gitignore::parse("", "*.log\nbuild\n");
        assert!(gi.is_ignored("a.log", false));
        assert!(gi.is_ignored("deep/nested/a.log", false));
        assert!(!gi.is_ignored("a.txt", false));
        assert!(!gi.is_ignored("logs/a.txt", false));
    }

    #[test]
    fn anchored_pattern_only_matches_from_base() {
        let gi = Gitignore::parse("sub", "/root-only.txt\n");
        assert!(gi.is_ignored("sub/root-only.txt", false));
        assert!(!gi.is_ignored("other/root-only.txt", false));
        // 锚定在 sub 目录：sub 下的同名文件不命中（模式无 `/` 时才是任意层级）
        assert!(!gi.is_ignored("sub/deep/root-only.txt", false));
    }

    #[test]
    fn directory_only_pattern() {
        let gi = Gitignore::parse("", "cache/\n");
        assert!(gi.is_ignored("cache", true));
        assert!(!gi.is_ignored("cache", false));
        assert!(!gi.is_ignored("cache/file.txt", false));
    }

    #[test]
    fn negation_re_includes() {
        let gi = Gitignore::parse("", "*.log\n!keep.log\n");
        assert!(gi.is_ignored("a.log", false));
        assert!(!gi.is_ignored("keep.log", false));
    }

    #[test]
    fn comments_and_blank_lines_are_skipped() {
        let gi = Gitignore::parse("", "# 注释\n\n   \n*.tmp\n");
        assert_eq!(gi.rules.len(), 1);
        assert!(gi.is_ignored("x.tmp", false));
    }

    #[test]
    fn double_star_crosses_directories() {
        assert!(glob_match_path("a/**/b", "a/x/y/b"));
        assert!(glob_match_path("a/**/b", "a/b"));
        assert!(glob_match_path("**/foo", "x/y/foo"));
        assert!(glob_match_path("a/**", "a/b/c"));
        assert!(!glob_match_path("a/**/b", "a/x/y/c"));
        // `*` 不跨 `/`
        assert!(!glob_match_path("a/*/b", "a/x/y/b"));
    }

    #[test]
    fn segment_glob_features() {
        assert!(glob_match_segment("*.log", "a.log"));
        assert!(!glob_match_segment("*.log", "a.log.txt"));
        assert!(glob_match_segment("a?c", "abc"));
        assert!(glob_match_segment("[abc]d", "bd"));
        assert!(!glob_match_segment("[!abc]d", "bd"));
        assert!(glob_match_segment("[a-z]d", "md"));
        assert!(!glob_match_segment("[a-z]d", "Zd"));
    }

    #[test]
    fn nested_layers_apply_deeper_first() {
        let mut stack = IgnoreStack::default();
        stack.push(Gitignore::parse("", "*.txt\n"));
        assert!(stack.is_ignored("a.txt", false));
        stack.push(Gitignore::parse("sub", "!a.txt\n"));
        assert!(!stack.is_ignored("sub/a.txt", false));
        // 父层规则在子目录仍然生效
        assert!(stack.is_ignored("sub/b.txt", false));
        stack.pop();
        assert!(stack.is_ignored("sub/a.txt", false));
    }
}
