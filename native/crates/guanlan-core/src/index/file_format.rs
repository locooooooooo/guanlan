//! 文件格式分类与快照配额策略（B01 · 全文件类型分级入库）。
//!
//! B01 之前，采集白名单只有 `md / svg / pdf` 三种，`files.format` 也只有这三个取值。
//! B01 放开白名单后，`files.format` 承载**细粒度扩展名 token**（小写、无点）：
//!
//! - 既有三值 `md / svg / pdf` **逐字不变**——老库里的 `file_id`、`revision_id`、
//!   `statement_id` 与既有事件身份不受影响（契约 §2.1 第 2 条：不生成第二套历史）。
//! - 新值按扩展名登记：`docx / xlsx / png / ts / mp4 / zip / bin`…
//!
//! 而**快照档位**、**渲染族**与**搜索过滤**按 [`FormatClass`] 判定：分类是
//! 扩展名的纯函数（不落库），因此历史版本行的档位判定永远稳定——档位在采集
//! 时刻落进 `revisions.snapshot_available`，之后不再重算。

/// 格式族：快照档位、渲染族与过滤语法的判定依据。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum FormatClass {
    /// Markdown 文档（`.md` / `.markdown`）
    Markdown,
    /// 纯文本（`.txt` / `.log` / `.rst` …）
    Text,
    /// 可语法高亮的源码与配置（`.ts` / `.py` / `.json` / `.yaml` …）
    Code,
    /// 矢量图（`.svg`）
    Vector,
    /// 位图（`.png` / `.jpg` / `.webp` …）
    Image,
    /// 版式文档（`.pdf` / `.docx` / `.rtf` / `.epub` …）
    Document,
    /// 表格（`.xlsx` / `.csv` / `.tsv` …）
    Spreadsheet,
    /// 演示稿（`.pptx` / `.odp` …）
    Presentation,
    /// 压缩包（`.zip` / `.7z` / `.tar.gz` …）
    Archive,
    /// 音频
    Audio,
    /// 视频
    Video,
    /// 字体
    Font,
    /// 其它二进制（未知扩展名 / 无扩展名）
    Binary,
}

impl FormatClass {
    /// 落库用的族名（前端徽标与统计口径用）。
    pub fn as_str(self) -> &'static str {
        match self {
            FormatClass::Markdown => "markdown",
            FormatClass::Text => "text",
            FormatClass::Code => "code",
            FormatClass::Vector => "vector",
            FormatClass::Image => "image",
            FormatClass::Document => "document",
            FormatClass::Spreadsheet => "spreadsheet",
            FormatClass::Presentation => "presentation",
            FormatClass::Archive => "archive",
            FormatClass::Audio => "audio",
            FormatClass::Video => "video",
            FormatClass::Font => "font",
            FormatClass::Binary => "binary",
        }
    }

    /// 格式族的人类可读中文标签（设置面板与筛选统计用）。
    pub fn label(self) -> &'static str {
        match self {
            FormatClass::Markdown => "Markdown",
            FormatClass::Text => "纯文本",
            FormatClass::Code => "源码与配置",
            FormatClass::Vector => "矢量图纸",
            FormatClass::Image => "图片",
            FormatClass::Document => "版式与办公文档",
            FormatClass::Spreadsheet => "表格与数据",
            FormatClass::Presentation => "演示文稿",
            FormatClass::Archive => "压缩归档",
            FormatClass::Audio => "音频",
            FormatClass::Video => "视频",
            FormatClass::Font => "字体",
            FormatClass::Binary => "二进制文件",
        }
    }

    /// 全量格式族有序列表（固定展示顺序）。
    pub const ALL: [FormatClass; 13] = [
        FormatClass::Markdown,
        FormatClass::Document,
        FormatClass::Spreadsheet,
        FormatClass::Presentation,
        FormatClass::Vector,
        FormatClass::Image,
        FormatClass::Code,
        FormatClass::Text,
        FormatClass::Archive,
        FormatClass::Audio,
        FormatClass::Video,
        FormatClass::Font,
        FormatClass::Binary,
    ];

    /// 是否属于「文本型」内容（文本/代码/图纸/表格）。
    ///
    /// 文本型的历史版本值得全量留快照：人会在阅读器里逐字比对，体积也小。
    pub fn is_text_like(self) -> bool {
        matches!(
            self,
            FormatClass::Markdown
                | FormatClass::Text
                | FormatClass::Code
                | FormatClass::Vector
                | FormatClass::Spreadsheet
        )
    }

    /// 是否属于「可预览的文档/图纸」族（阅读器可直接渲染）。
    pub fn is_previewable(self) -> bool {
        matches!(
            self,
            FormatClass::Markdown
                | FormatClass::Text
                | FormatClass::Code
                | FormatClass::Vector
                | FormatClass::Image
                | FormatClass::Document
                | FormatClass::Spreadsheet
                | FormatClass::Presentation
        )
    }
}

/// 未知/无扩展名文件的落库 token。
pub const BINARY_TOKEN: &str = "bin";

/// 文件格式：细粒度扩展名 token + 派生的格式族。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileFormat {
    token: String,
    class: FormatClass,
}

impl FileFormat {
    /// 由扩展名（不含点，小写）构造。未知扩展名归入 [`FormatClass::Binary`]，
    /// 但**仍保留原 token**——`files.format` 必须如实反映磁盘上的真实扩展名。
    pub fn of_extension(ext: &str) -> Self {
        let token = ext.trim_start_matches('.').to_ascii_lowercase();
        let token = if token.is_empty() {
            BINARY_TOKEN.to_owned()
        } else {
            token
        };
        let class = class_of_token(&token);
        Self { token, class }
    }

    /// 解析库里已存的 `files.format` 值。任何非空 token 都可解析（未知扩展名
    /// 归 `Binary`）——不再像旧实现那样对未知格式返回 `None`。
    pub fn parse(raw: &str) -> Option<Self> {
        let raw = raw.trim();
        if raw.is_empty() {
            return None;
        }
        Some(Self::of_extension(raw))
    }

    /// 落库用的 token（`md` / `svg` / `pdf` / `docx` / `bin` …）。
    pub fn as_str(&self) -> &str {
        &self.token
    }

    /// 派生的格式族。
    pub fn class(&self) -> FormatClass {
        self.class
    }

    /// 是否为 Markdown（决定是否抽取决定/陈述证据）。
    pub fn is_markdown(&self) -> bool {
        self.class == FormatClass::Markdown
    }

    /// 是否为受支持的结构化 OOXML Office 文档（`.docx` / `.xlsx` 等，B03 走 L2 抽取）。
    pub fn is_office_structured(&self) -> bool {
        matches!(
            self.token.as_str(),
            "docx" | "docm" | "dotx" | "xlsx" | "xlsm" | "xltx"
        )
    }

    /// 是否为 UTF-8 纯文本族（变更摘要可安全按行比对，不把大二进制读入内存）。
    ///
    /// 注意：`xlsx` / `xls` / `ods` / `parquet` 虽然同属 `Spreadsheet`，但磁盘字节是
    /// ZIP/二进制格式，不可按 UTF-8 行拆；只对 `csv` / `tsv` 放行文本 diff。
    pub fn is_utf8_text(&self) -> bool {
        match self.class {
            FormatClass::Markdown | FormatClass::Text | FormatClass::Code | FormatClass::Vector => {
                true
            }
            FormatClass::Spreadsheet => matches!(self.token.as_str(), "csv" | "tsv"),
            _ => false,
        }
    }

    /// 供流式下载 / QuickLook 使用的 MIME 类型。
    pub fn mime_type(&self) -> &'static str {
        match self.token.as_str() {
            "md" | "markdown" | "mdown" | "mkd" | "mdx" | "rmd" => "text/markdown; charset=utf-8",
            "svg" | "svgz" => "image/svg+xml",
            "pdf" => "application/pdf",
            "png" | "apng" => "image/png",
            "jpg" | "jpeg" | "jfif" | "jpe" => "image/jpeg",
            "webp" => "image/webp",
            "gif" => "image/gif",
            "bmp" | "dib" => "image/bmp",
            "ico" => "image/x-icon",
            "avif" => "image/avif",
            "json" | "json5" | "jsonc" | "jsonl" | "ndjson" => "application/json; charset=utf-8",
            "html" | "htm" | "xhtml" => "text/html; charset=utf-8",
            "css" => "text/css; charset=utf-8",
            "csv" => "text/csv; charset=utf-8",
            "tsv" => "text/tab-separated-values; charset=utf-8",
            "xml" | "xsl" | "xslt" | "xsd" => "application/xml; charset=utf-8",
            "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            "xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            "pptx" => "application/vnd.openxmlformats-officedocument.presentationml.presentation",
            "zip" => "application/zip",
            "mp3" => "audio/mpeg",
            "wav" => "audio/wav",
            "mp4" | "m4v" => "video/mp4",
            "webm" => "video/webm",
            _ if self.is_utf8_text() => "text/plain; charset=utf-8",
            _ => "application/octet-stream",
        }
    }

    /// 两个格式是否「兼容」（重命名时用于守住阅读器契约）。
    ///
    /// 同一格式族即兼容（例如 `md ↔ markdown`、`png ↔ jpg`、未知扩展名 `dat ↔ bak`）；
    /// 跨族重命名（如 `md ↔ exe`、`bin ↔ md`、`md ↔ svg`）一律拦住，否则阅读器会拿到
    /// 读不了或与扩展名矛盾的类型。
    pub fn is_compatible_with(&self, other: &Self) -> bool {
        self.class == other.class
    }
}

/// 由 token（扩展名）判定格式族。
pub fn class_of_token(token: &str) -> FormatClass {
    match token {
        // ---- Markdown ----
        "md" | "markdown" | "mdown" | "mkd" | "mdx" | "rmd" => FormatClass::Markdown,

        // ---- 纯文本 ----
        "txt" | "text" | "log" | "rst" | "adoc" | "asciidoc" | "nfo" | "me" | "1st" | "readme"
        | "license" | "changelog" => FormatClass::Text,

        // ---- 源码与配置（可语法高亮） ----
        "ts" | "tsx" | "js" | "jsx" | "mjs" | "cjs" | "mts" | "cts" | "coffee" | "py" | "pyi"
        | "pyw" | "rb" | "rs" | "go" | "java" | "kt" | "kts" | "scala" | "groovy" | "gradle"
        | "c" | "h" | "cc" | "cpp" | "cxx" | "hpp" | "hh" | "c++" | "h++" | "cs" | "fs" | "fsx"
        | "vb" | "php" | "phtml" | "swift" | "m" | "mm" | "dart" | "lua" | "pl" | "pm" | "r"
        | "jl" | "ex" | "exs" | "erl" | "hrl" | "hs" | "lhs" | "clj" | "cljs" | "cljc" | "elm"
        | "nim" | "zig" | "v" | "sol" | "asm" | "s" | "f" | "f90" | "f95" | "for" | "cr" | "d"
        | "pas" | "pp" | "vim" | "el" | "rkt" | "tcl" | "ahk" | "au3" | "ino" | "vue"
        | "svelte" | "astro" | "sql" | "ddl" | "dml" | "sh" | "bash" | "zsh" | "fish" | "ksh"
        | "ps1" | "psm1" | "bat" | "cmd" | "nu" | "tclsh" | "es" | "es6" | "rjsx" | "make"
        | "mk" | "mak" | "cmake" | "dockerfile" | "containerfile" | "proto" | "thrift"
        | "graphql" | "gql" | "prisma" | "tf" | "tfvars" | "hcl" | "tfstate" | "json" | "json5"
        | "jsonc" | "jsonl" | "ndjson" | "yaml" | "yml" | "toml" | "ini" | "cfg" | "conf"
        | "properties" | "env" | "editorconfig" | "xml" | "xsl" | "xslt" | "xsd" | "dtd"
        | "html" | "htm" | "xhtml" | "shtml" | "vuehtml" | "css" | "scss" | "sass" | "less"
        | "styl" | "postcss" | "ipynb" | "diff" | "patch" | "lock" | "gitignore"
        | "gitattributes" | "gitmodules" | "npmrc" | "yarnrc" | "babelrc" | "eslintrc"
        | "prettierrc" | "editor" | "vimrc" | "bashrc" | "zshrc" | "profile" | "tex" | "bib"
        | "sty" | "cls" => FormatClass::Code,

        // ---- 矢量图 ----
        "svg" | "svgz" => FormatClass::Vector,

        // ---- 位图 ----
        "png" | "apng" | "jpg" | "jpeg" | "jfif" | "jpe" | "webp" | "gif" | "bmp" | "dib"
        | "ico" | "cur" | "tif" | "tiff" | "avif" | "heic" | "heif" | "jxl" | "jp2" | "j2k"
        | "ppm" | "pgm" | "pbm" | "pnm" | "tga" | "pcx" | "exr" | "hdr" | "raw" | "cr2" | "nef"
        | "arw" | "dng" | "psd" | "xcf" | "ai" | "eps" => FormatClass::Image,

        // ---- 版式文档 ----
        "pdf" | "doc" | "docx" | "docm" | "dot" | "dotx" | "rtf" | "odt" | "epub" | "mobi"
        | "azw" | "azw3" | "fb2" | "pages" => FormatClass::Document,

        // ---- 表格 ----
        "xlsx" | "xlsm" | "xlsb" | "xls" | "xlt" | "xltx" | "ods" | "csv" | "tsv" | "numbers"
        | "parquet" => FormatClass::Spreadsheet,

        // ---- 演示稿 ----
        "pptx" | "pptm" | "ppt" | "pps" | "ppsx" | "odp" | "key" => FormatClass::Presentation,

        // ---- 压缩包 ----
        "zip" | "7z" | "rar" | "tar" | "gz" | "tgz" | "bz2" | "tbz" | "xz" | "txz" | "zst"
        | "lz" | "lzma" | "cab" | "jar" | "war" | "ear" | "whl" | "egg" | "apk" | "aab" | "ipa"
        | "deb" | "rpm" | "msi" | "iso" => FormatClass::Archive,

        // ---- 音频 ----
        "mp3" | "wav" | "flac" | "aac" | "m4a" | "ogg" | "oga" | "opus" | "wma" | "aiff"
        | "aif" | "mid" | "midi" | "amr" | "ape" | "mka" => FormatClass::Audio,

        // ---- 视频 ----
        // 注：`.ts` / `.mts` 优先归入源码（TypeScript）；MPEG-TS 流使用 `.m2ts`
        "mp4" | "m4v" | "mkv" | "webm" | "mov" | "qt" | "avi" | "wmv" | "flv" | "f4v" | "mpg"
        | "mpeg" | "mpe" | "3gp" | "3g2" | "m2ts" | "vob" | "rmvb" | "rm" | "asf" | "ogv" => {
            FormatClass::Video
        }

        // ---- 字体 ----
        "ttf" | "otf" | "woff" | "woff2" | "eot" | "ttc" | "fon" => FormatClass::Font,

        _ => FormatClass::Binary,
    }
}

/// 快照档位：决定「是否复制一份去重快照」。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SnapshotTier {
    /// 全量去重快照（内容写进 `blobs/`，可回看历史原文）。
    Full,
    /// 仅记身份、尺寸、mtime 与流式哈希——**不复制字节**，`snapshot_available = 0`。
    MetadataOnly,
}

impl SnapshotTier {
    /// 是否落快照。
    pub fn stores_bytes(self) -> bool {
        matches!(self, SnapshotTier::Full)
    }
}

/// 文本/代码/图纸的快照阈值（默认 10MB）。
pub const DEFAULT_TEXT_SNAPSHOT_MAX_BYTES: i64 = 10 * 1024 * 1024;
/// PDF/Office/图片/压缩包的快照阈值（默认 50MB）。
pub const DEFAULT_BINARY_SNAPSHOT_MAX_BYTES: i64 = 50 * 1024 * 1024;

/// 快照配额策略：两档阈值，可按工作区上调（§6「可按工作区上调」）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SnapshotPolicy {
    /// 文本型（Markdown/文本/代码/矢量图/表格）的全量快照上限（字节）。
    pub text_max_bytes: i64,
    /// 二进制型（位图/版式文档/演示稿/压缩包）的全量快照上限（字节）。
    pub binary_max_bytes: i64,
}

impl Default for SnapshotPolicy {
    fn default() -> Self {
        Self {
            text_max_bytes: DEFAULT_TEXT_SNAPSHOT_MAX_BYTES,
            binary_max_bytes: DEFAULT_BINARY_SNAPSHOT_MAX_BYTES,
        }
    }
}

impl SnapshotPolicy {
    /// 按环境变量覆盖阈值：
    /// - `GUANLAN_SNAPSHOT_TEXT_MAX_MB`：文本型上限（默认 10MB）
    /// - `GUANLAN_SNAPSHOT_BINARY_MAX_MB`：二进制型上限（默认 50MB）
    ///
    /// 音频/视频/字体/未知二进制**不受阈值影响**——永远只记元数据。
    pub fn from_env() -> Self {
        Self::from_overrides_and_env(None, None)
    }

    /// 结合工作区持久化阈值（`meta` 表）与环境变量构造有效策略（env 优先）。
    pub fn from_overrides_and_env(text_max_mb: Option<i64>, binary_max_mb: Option<i64>) -> Self {
        let mut policy = Self::default();
        if let Some(mb) = text_max_mb {
            if mb > 0 {
                policy.text_max_bytes = mb.saturating_mul(1024 * 1024);
            }
        }
        if let Some(mb) = binary_max_mb {
            if mb > 0 {
                policy.binary_max_bytes = mb.saturating_mul(1024 * 1024);
            }
        }
        if let Some(mb) = read_env_i64("GUANLAN_SNAPSHOT_TEXT_MAX_MB") {
            if mb > 0 {
                policy.text_max_bytes = mb.saturating_mul(1024 * 1024);
            }
        }
        if let Some(mb) = read_env_i64("GUANLAN_SNAPSHOT_BINARY_MAX_MB") {
            if mb > 0 {
                policy.binary_max_bytes = mb.saturating_mul(1024 * 1024);
            }
        }
        policy
    }

    /// 是否设置了环境变量覆盖（用于决定 `from_env` 是否显式覆盖工作区持久化配置）。
    pub fn env_override_present() -> bool {
        read_env_i64("GUANLAN_SNAPSHOT_TEXT_MAX_MB").is_some_and(|v| v > 0)
            || read_env_i64("GUANLAN_SNAPSHOT_BINARY_MAX_MB").is_some_and(|v| v > 0)
    }

    /// 判定某个文件的快照档位。
    pub fn tier_for(&self, class: FormatClass, size_bytes: i64) -> SnapshotTier {
        match class {
            // 音频/视频/字体/未知二进制：只记身份、尺寸、mtime 与流式哈希
            FormatClass::Audio | FormatClass::Video | FormatClass::Font | FormatClass::Binary => {
                SnapshotTier::MetadataOnly
            }
            // 文本型：< text_max 全量快照
            FormatClass::Markdown
            | FormatClass::Text
            | FormatClass::Code
            | FormatClass::Vector
            | FormatClass::Spreadsheet => {
                if size_bytes < self.text_max_bytes {
                    SnapshotTier::Full
                } else {
                    SnapshotTier::MetadataOnly
                }
            }
            // 二进制型（位图/文档/演示稿/压缩包）：< binary_max 全量快照
            FormatClass::Image
            | FormatClass::Document
            | FormatClass::Presentation
            | FormatClass::Archive => {
                if size_bytes < self.binary_max_bytes {
                    SnapshotTier::Full
                } else {
                    SnapshotTier::MetadataOnly
                }
            }
        }
    }
}

/// 读环境变量里的非负整数
fn read_env_i64(key: &str) -> Option<i64> {
    std::env::var(key)
        .ok()
        .and_then(|raw| raw.trim().parse::<i64>().ok())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn existing_three_tokens_stay_verbatim() {
        assert_eq!(FileFormat::of_extension("md").as_str(), "md");
        assert_eq!(FileFormat::of_extension("svg").as_str(), "svg");
        assert_eq!(FileFormat::of_extension("pdf").as_str(), "pdf");
        assert_eq!(FileFormat::of_extension("MD").as_str(), "md");
        assert_eq!(FileFormat::of_extension("markdown").as_str(), "markdown");
    }

    #[test]
    fn class_mapping_covers_b01_targets() {
        assert_eq!(
            FileFormat::of_extension("md").class(),
            FormatClass::Markdown
        );
        assert_eq!(FileFormat::of_extension("ts").class(), FormatClass::Code);
        assert_eq!(FileFormat::of_extension("json").class(), FormatClass::Code);
        assert_eq!(
            FileFormat::of_extension("csv").class(),
            FormatClass::Spreadsheet
        );
        assert_eq!(
            FileFormat::of_extension("docx").class(),
            FormatClass::Document
        );
        assert_eq!(
            FileFormat::of_extension("xlsx").class(),
            FormatClass::Spreadsheet
        );
        assert_eq!(FileFormat::of_extension("png").class(), FormatClass::Image);
        assert_eq!(FileFormat::of_extension("mp4").class(), FormatClass::Video);
        assert_eq!(
            FileFormat::of_extension("zip").class(),
            FormatClass::Archive
        );
        assert_eq!(
            FileFormat::of_extension("unknownext").class(),
            FormatClass::Binary
        );
        assert_eq!(FileFormat::of_extension("").as_str(), BINARY_TOKEN);
    }

    #[test]
    fn tier_policy_follows_three_bands() {
        let policy = SnapshotPolicy::default();
        // 文本型 < 10MB → 全量快照
        assert_eq!(
            policy.tier_for(FormatClass::Markdown, 5 * 1024 * 1024),
            SnapshotTier::Full
        );
        // 文本型 ≥ 10MB → 只记元数据
        assert_eq!(
            policy.tier_for(FormatClass::Code, 12 * 1024 * 1024),
            SnapshotTier::MetadataOnly
        );
        // 二进制型 < 50MB → 全量快照
        assert_eq!(
            policy.tier_for(FormatClass::Image, 20 * 1024 * 1024),
            SnapshotTier::Full
        );
        // 二进制型 ≥ 50MB → 只记元数据
        assert_eq!(
            policy.tier_for(FormatClass::Document, 50 * 1024 * 1024),
            SnapshotTier::MetadataOnly
        );
        // 音视频永远只记元数据（2GB 视频不复制快照）
        assert_eq!(
            policy.tier_for(FormatClass::Video, 2 * 1024 * 1024 * 1024),
            SnapshotTier::MetadataOnly
        );
        assert_eq!(
            policy.tier_for(FormatClass::Audio, 1024),
            SnapshotTier::MetadataOnly
        );
        assert_eq!(
            policy.tier_for(FormatClass::Binary, 1024),
            SnapshotTier::MetadataOnly
        );
    }

    #[test]
    fn rename_compatibility_is_class_based() {
        let md = FileFormat::of_extension("md");
        let markdown = FileFormat::of_extension("markdown");
        let png = FileFormat::of_extension("png");
        let jpg = FileFormat::of_extension("jpg");
        let bin = FileFormat::of_extension("bin");
        let exe = FileFormat::of_extension("exe");
        assert!(md.is_compatible_with(&markdown));
        assert!(png.is_compatible_with(&jpg));
        assert!(bin.is_compatible_with(&exe));
        assert!(!md.is_compatible_with(&png));
        assert!(!md.is_compatible_with(&exe));
        assert!(!bin.is_compatible_with(&md));
    }
}
