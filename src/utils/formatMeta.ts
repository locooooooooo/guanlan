/**
 * B01 · 全文件格式统一元数据映射（与 `guanlan-core/src/index/file_format.rs` 逐项对齐）。
 *
 * 原则：
 * - 单一数据源：所有组件（侧栏筛选、图集卡、日历、时间线、画布、阅读器、设置面板）
 *   共享本模块，不在各视图散落重复的 Record<FileFormat, ...> 查找表；
 * - 既有 `md` / `svg` / `pdf` 保持原有色彩与语义不变；
 * - 任何未知扩展名（含无扩展名 `bin`）一律优雅降级为中性样式，永不返回 `undefined`。
 */

export type FormatClass =
  | 'markdown'
  | 'text'
  | 'code'
  | 'vector'
  | 'image'
  | 'document'
  | 'spreadsheet'
  | 'presentation'
  | 'archive'
  | 'audio'
  | 'video'
  | 'font'
  | 'binary';

const EXTENSION_CLASSES: Record<string, FormatClass> = {
  // Markdown
  md: 'markdown',
  markdown: 'markdown',
  mdown: 'markdown',
  mkd: 'markdown',
  mdx: 'markdown',
  rmd: 'markdown',
  // 纯文本
  txt: 'text',
  text: 'text',
  log: 'text',
  rst: 'text',
  adoc: 'text',
  asciidoc: 'text',
  nfo: 'text',
  me: 'text',
  '1st': 'text',
  readme: 'text',
  license: 'text',
  changelog: 'text',
  // 源码与配置
  ts: 'code',
  tsx: 'code',
  js: 'code',
  jsx: 'code',
  mjs: 'code',
  cjs: 'code',
  mts: 'code',
  cts: 'code',
  coffee: 'code',
  py: 'code',
  pyi: 'code',
  pyw: 'code',
  rb: 'code',
  rs: 'code',
  go: 'code',
  java: 'code',
  kt: 'code',
  kts: 'code',
  scala: 'code',
  groovy: 'code',
  gradle: 'code',
  c: 'code',
  h: 'code',
  cc: 'code',
  cpp: 'code',
  cxx: 'code',
  hpp: 'code',
  hh: 'code',
  cs: 'code',
  fs: 'code',
  fsx: 'code',
  vb: 'code',
  php: 'code',
  swift: 'code',
  m: 'code',
  mm: 'code',
  dart: 'code',
  lua: 'code',
  pl: 'code',
  r: 'code',
  jl: 'code',
  ex: 'code',
  exs: 'code',
  erl: 'code',
  hs: 'code',
  clj: 'code',
  zig: 'code',
  nim: 'code',
  vue: 'code',
  svelte: 'code',
  astro: 'code',
  sql: 'code',
  sh: 'code',
  bash: 'code',
  zsh: 'code',
  fish: 'code',
  ps1: 'code',
  bat: 'code',
  cmd: 'code',
  make: 'code',
  cmake: 'code',
  dockerfile: 'code',
  containerfile: 'code',
  proto: 'code',
  graphql: 'code',
  gql: 'code',
  tf: 'code',
  hcl: 'code',
  json: 'code',
  json5: 'code',
  jsonc: 'code',
  jsonl: 'code',
  ndjson: 'code',
  yaml: 'code',
  yml: 'code',
  toml: 'code',
  ini: 'code',
  cfg: 'code',
  conf: 'code',
  env: 'code',
  editorconfig: 'code',
  xml: 'code',
  html: 'code',
  htm: 'code',
  xhtml: 'code',
  shtml: 'code',
  css: 'code',
  scss: 'code',
  sass: 'code',
  less: 'code',
  ipynb: 'code',
  diff: 'code',
  patch: 'code',
  lock: 'code',
  gitignore: 'code',
  gitattributes: 'code',
  gitmodules: 'code',
  npmrc: 'code',
  yarnrc: 'code',
  babelrc: 'code',
  eslintrc: 'code',
  prettierrc: 'code',
  tex: 'code',
  bib: 'code',
  // 矢量图
  svg: 'vector',
  svgz: 'vector',
  // 位图
  png: 'image',
  apng: 'image',
  jpg: 'image',
  jpeg: 'image',
  jfif: 'image',
  jpe: 'image',
  webp: 'image',
  gif: 'image',
  bmp: 'image',
  dib: 'image',
  ico: 'image',
  cur: 'image',
  tif: 'image',
  tiff: 'image',
  avif: 'image',
  heic: 'image',
  heif: 'image',
  jxl: 'image',
  psd: 'image',
  xcf: 'image',
  ai: 'image',
  eps: 'image',
  // 版式与办公文档
  pdf: 'document',
  doc: 'document',
  docx: 'document',
  docm: 'document',
  dot: 'document',
  dotx: 'document',
  rtf: 'document',
  odt: 'document',
  epub: 'document',
  mobi: 'document',
  pages: 'document',
  // 表格与数据
  xlsx: 'spreadsheet',
  xlsm: 'spreadsheet',
  xlsb: 'spreadsheet',
  xls: 'spreadsheet',
  xltx: 'spreadsheet',
  ods: 'spreadsheet',
  csv: 'spreadsheet',
  tsv: 'spreadsheet',
  numbers: 'spreadsheet',
  parquet: 'spreadsheet',
  // 演示稿
  pptx: 'presentation',
  pptm: 'presentation',
  ppt: 'presentation',
  ppsx: 'presentation',
  odp: 'presentation',
  key: 'presentation',
  // 归档
  zip: 'archive',
  '7z': 'archive',
  rar: 'archive',
  tar: 'archive',
  gz: 'archive',
  tgz: 'archive',
  bz2: 'archive',
  xz: 'archive',
  zst: 'archive',
  jar: 'archive',
  whl: 'archive',
  apk: 'archive',
  msi: 'archive',
  iso: 'archive',
  // 音频
  mp3: 'audio',
  wav: 'audio',
  flac: 'audio',
  aac: 'audio',
  m4a: 'audio',
  ogg: 'audio',
  opus: 'audio',
  wma: 'audio',
  aiff: 'audio',
  mid: 'audio',
  midi: 'audio',
  // 视频
  mp4: 'video',
  m4v: 'video',
  mkv: 'video',
  webm: 'video',
  mov: 'video',
  qt: 'video',
  avi: 'video',
  wmv: 'video',
  flv: 'video',
  mpg: 'video',
  mpeg: 'video',
  m2ts: 'video',
  ogv: 'video',
  // 字体
  ttf: 'font',
  otf: 'font',
  woff: 'font',
  woff2: 'font',
  eot: 'font',
  ttc: 'font',
};

const CLASS_LABELS: Record<FormatClass, string> = {
  markdown: 'Markdown',
  text: '纯文本',
  code: '源码与配置',
  vector: '矢量图纸',
  image: '图片',
  document: '版式与办公文档',
  spreadsheet: '表格与数据',
  presentation: '演示文稿',
  archive: '压缩归档',
  audio: '音频',
  video: '视频',
  font: '字体',
  binary: '二进制文件',
};

export interface FormatUiMeta {
  token: string;
  label: string;
  formatClass: FormatClass;
  classLabel: string;
  /** 侧栏 / 首页圆点颜色 */
  dotColor: string;
  /** 图集卡片徽标样式 */
  badgeClass: string;
  /** 日历卡片语义配色 */
  calendarColor: { text: string; border: string; bg: string };
}

const CLASS_UI_STYLE: Record<
  FormatClass,
  {
    dotColor: string;
    badgeClass: string;
    calendarColor: { text: string; border: string; bg: string };
  }
> = {
  markdown: {
    dotColor: '#F76808',
    badgeClass: 'bg-[#F5E9E2] border border-[#D97757]/40 text-[#B05C3B] dark:bg-[#D97757]/18 dark:border-[#D97757]/45 dark:text-[#F4A688]',
    calendarColor: { text: '#0B7A90', border: 'rgba(14, 152, 180, 0.42)', bg: '#E6F5F9' },
  },
  vector: {
    dotColor: '#8E8AE6',
    badgeClass: 'bg-[#ECE9FB] border border-[#9B8AFB]/45 text-[#6D5BD0] dark:bg-[#9B8AFB]/18 dark:border-[#9B8AFB]/45 dark:text-[#C8BEFF]',
    calendarColor: { text: '#6D5BD0', border: 'rgba(139, 124, 246, 0.42)', bg: '#EFECFD' },
  },
  document: {
    dotColor: '#F5D90A',
    badgeClass: 'bg-[#F6EEDD] border border-[#D99B52]/50 text-[#A8762B] dark:bg-[#D99B52]/18 dark:border-[#D99B52]/45 dark:text-[#F3C46C]',
    calendarColor: { text: '#A8762B', border: 'rgba(217, 155, 82, 0.48)', bg: '#FAF1E1' },
  },
  code: {
    dotColor: '#0E98B4',
    badgeClass: 'bg-[#E6F5F9] border border-[#0E98B4]/35 text-[#0B7A90] dark:bg-[#0E98B4]/18 dark:border-[#0E98B4]/45 dark:text-[#67D5EB]',
    calendarColor: { text: '#0B7A90', border: 'rgba(14, 152, 180, 0.4)', bg: '#E6F5F9' },
  },
  text: {
    dotColor: '#5B8C5A',
    badgeClass: 'bg-[#EBF4EC] border border-[#5B8C5A]/35 text-[#3F6B3E] dark:bg-[#5B8C5A]/18 dark:border-[#5B8C5A]/45 dark:text-[#98D197]',
    calendarColor: { text: '#3F6B3E', border: 'rgba(91, 140, 90, 0.4)', bg: '#EBF4EC' },
  },
  image: {
    dotColor: '#D9468F',
    badgeClass: 'bg-[#FCEBF3] border border-[#D9468F]/35 text-[#A62C67] dark:bg-[#D9468F]/18 dark:border-[#D9468F]/45 dark:text-[#F48BBD]',
    calendarColor: { text: '#A62C67', border: 'rgba(217, 70, 143, 0.4)', bg: '#FCEBF3' },
  },
  spreadsheet: {
    dotColor: '#2E8B57',
    badgeClass: 'bg-[#E7F5EE] border border-[#2E8B57]/35 text-[#226B42] dark:bg-[#2E8B57]/18 dark:border-[#2E8B57]/45 dark:text-[#7ADBA3]',
    calendarColor: { text: '#226B42', border: 'rgba(46, 139, 87, 0.4)', bg: '#E7F5EE' },
  },
  presentation: {
    dotColor: '#E06D3B',
    badgeClass: 'bg-[#FBECE5] border border-[#E06D3B]/35 text-[#B44F24] dark:bg-[#E06D3B]/18 dark:border-[#E06D3B]/45 dark:text-[#F4A17C]',
    calendarColor: { text: '#B44F24', border: 'rgba(224, 109, 59, 0.4)', bg: '#FBECE5' },
  },
  archive: {
    dotColor: '#7C6F64',
    badgeClass: 'bg-[#F1EFEA] border border-[#7C6F64]/35 text-[#5A5047] dark:bg-[#7C6F64]/22 dark:border-[#A39588]/40 dark:text-[#D1C6BC]',
    calendarColor: { text: '#5A5047', border: 'rgba(124, 111, 100, 0.38)', bg: '#F1EFEA' },
  },
  audio: {
    dotColor: '#7B61FF',
    badgeClass: 'bg-[#EFEAFF] border border-[#7B61FF]/35 text-[#563FD1] dark:bg-[#7B61FF]/18 dark:border-[#7B61FF]/45 dark:text-[#BEB0FF]',
    calendarColor: { text: '#563FD1', border: 'rgba(123, 97, 255, 0.38)', bg: '#EFEAFF' },
  },
  video: {
    dotColor: '#B84A39',
    badgeClass: 'bg-[#FAECE9] border border-[#B84A39]/35 text-[#8E3527] dark:bg-[#B84A39]/20 dark:border-[#D96D5C]/45 dark:text-[#F29C8E]',
    calendarColor: { text: '#8E3527', border: 'rgba(184, 74, 57, 0.38)', bg: '#FAECE9' },
  },
  font: {
    dotColor: '#6B7280',
    badgeClass: 'bg-[#F1F2F4] border border-[#6B7280]/30 text-[#4B5563] dark:bg-[#6B7280]/22 dark:border-[#9CA3AF]/35 dark:text-[#D1D5DB]',
    calendarColor: { text: '#4B5563', border: 'rgba(107, 114, 128, 0.36)', bg: '#F1F2F4' },
  },
  binary: {
    dotColor: '#8B8982',
    badgeClass: 'bg-[#F3F2EE] border border-[#8B8982]/35 text-[#5F5D57] dark:bg-[#8B8982]/22 dark:border-[#A8A69E]/35 dark:text-[#D4D2CA]',
    calendarColor: { text: '#5F5D57', border: 'rgba(139, 137, 130, 0.36)', bg: '#F3F2EE' },
  },
};

export const UNDATED_CALENDAR_COLOR = {
  text: '#A8762B',
  border: 'rgba(217, 155, 82, 0.45)',
  bg: '#F8EFE0',
};

export function normalizeFormatToken(format: string | null | undefined): string {
  const clean = (format ?? '').trim().replace(/^\./, '').toLowerCase();
  return clean || 'bin';
}

export function formatClassOf(format: string | null | undefined): FormatClass {
  const token = normalizeFormatToken(format);
  return EXTENSION_CLASSES[token] ?? 'binary';
}

export function formatClassLabel(cls: FormatClass): string {
  return CLASS_LABELS[cls];
}

export function formatLabel(format: string | null | undefined): string {
  const token = normalizeFormatToken(format);
  return token.toUpperCase();
}

export function isUtf8TextFormat(format: string | null | undefined): boolean {
  const token = normalizeFormatToken(format);
  const cls = formatClassOf(token);
  if (cls === 'markdown' || cls === 'text' || cls === 'code' || cls === 'vector') {
    return true;
  }
  return cls === 'spreadsheet' && (token === 'csv' || token === 'tsv');
}

export function isStructuredOfficeFormat(format: string | null | undefined): boolean {
  const token = normalizeFormatToken(format);
  return (
    token === 'docx' ||
    token === 'docm' ||
    token === 'dotx' ||
    token === 'xlsx' ||
    token === 'xlsm' ||
    token === 'xltx'
  );
}

export function isPreviewableHtmlFormat(format: string | null | undefined): boolean {
  const token = normalizeFormatToken(format);
  return token === 'html' || token === 'htm' || token === 'xhtml' || token === 'shtml';
}

export function isPreviewableImageFormat(format: string | null | undefined): boolean {
  const token = normalizeFormatToken(format);
  return (
    token === 'png' ||
    token === 'apng' ||
    token === 'jpg' ||
    token === 'jpeg' ||
    token === 'jfif' ||
    token === 'jpe' ||
    token === 'webp' ||
    token === 'gif' ||
    token === 'bmp' ||
    token === 'ico' ||
    token === 'avif'
  );
}

export function formatUiMeta(format: string | null | undefined): FormatUiMeta {
  const token = normalizeFormatToken(format);
  const formatClass = formatClassOf(token);
  const style = CLASS_UI_STYLE[formatClass];
  return {
    token,
    label: token.toUpperCase(),
    formatClass,
    classLabel: CLASS_LABELS[formatClass],
    ...style,
  };
}

export function getCalendarFormatColor(
  format: string | 'undated' | null | undefined
): { text: string; border: string; bg: string } {
  if (format === 'undated' || !format) return UNDATED_CALENDAR_COLOR;
  return formatUiMeta(format).calendarColor;
}

/** 供三档快照政策展示：判定给定格式属于哪一档 */
export function snapshotTierDescription(format: string | null | undefined): {
  tier: 'text' | 'binary' | 'metadata_only';
  title: string;
} {
  const cls = formatClassOf(format);
  if (
    cls === 'markdown' ||
    cls === 'text' ||
    cls === 'code' ||
    cls === 'vector' ||
    cls === 'spreadsheet'
  ) {
    return { tier: 'text', title: '第一档 · 文本/代码/图纸（默认 < 10 MiB 存去重快照）' };
  }
  if (cls === 'image' || cls === 'document' || cls === 'presentation' || cls === 'archive') {
    return { tier: 'binary', title: '第二档 · 办公/PDF/图片（默认 < 50 MiB 存去重快照）' };
  }
  return {
    tier: 'metadata_only',
    title: '第三档 · 音视频/未知二进制（仅记身份、尺寸与 SHA-256，不复制字节）',
  };
}

// ===== V05 · 全景域过滤 SSOT（全部资产 / 业务文档 / 工程代码，严格 MECE 计数守恒） =====

export type AssetDomainFilter = 'all' | 'business' | 'code';

/**
 * 复用 B01 文档族分类 SSOT（`formatClassOf`）将每份资产严格划分到两大互斥域：
 * - `code`（工程代码）：源码/配置/归档/字体/未知二进制（一键滤除数千份源码噪点）
 * - `business`（业务文档）：Markdown/纯文本/PDF/Office/表格/演示稿/SVG/位图/音视频
 * 恒满足：`business + code === all`（零重叠、零遗漏）。
 */
export function classifyAssetDomain(format: string | null | undefined): 'business' | 'code' {
  const cls = formatClassOf(format);
  if (cls === 'code' || cls === 'binary' || cls === 'archive' || cls === 'font') {
    return 'code';
  }
  return 'business';
}

export function countAssetsByDomain<T extends { format: string }>(
  files: readonly T[]
): { all: number; business: number; code: number } {
  let business = 0;
  let code = 0;
  for (const f of files) {
    if (classifyAssetDomain(f.format) === 'code') code += 1;
    else business += 1;
  }
  return { all: files.length, business, code };
}

export function filterAssetsByDomain<
  F extends { file_id: string; format: string },
  E extends { file_id?: string | null }
>(
  files: readonly F[],
  events: readonly E[],
  domain: AssetDomainFilter
): { files: F[]; events: E[] } {
  if (domain === 'all') {
    return { files: files as F[], events: events as E[] };
  }
  const keptFiles = files.filter((f) => classifyAssetDomain(f.format) === domain);
  const keptIds = new Set(keptFiles.map((f) => f.file_id));
  const keptEvents = events.filter(
    (e) => Boolean(e.file_id) && keptIds.has(e.file_id as string)
  );
  return { files: keptFiles, events: keptEvents };
}
