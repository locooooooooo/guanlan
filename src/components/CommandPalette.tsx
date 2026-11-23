import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Clock, FileText, FolderOpen, Layers, Search, Sparkles } from 'lucide-react';
import {
  buildSnippet,
  resolveRelativeDay,
  type SnippetResult,
  type SnippetSegment,
} from '../utils/commandPaletteGrammar';
import type { PaletteItem } from '../utils/commandPaletteResults';
import { revisionThumbnailUrl } from '../services/workspaceClient';
import type { FileRecord } from '../types/guanlan';
import { extractCoreSummary, taskPackageOf } from '../utils/taskPackages';
import { parseMarkdownOutline } from '../utils/guanlanEngine';
import { formatRelativeObservedAt } from '../utils/timeFormat';
import { Badge, CommandFooter, CommandPanel, Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle, Kbd, ScrollArea } from './ui';

/**
 * C03 · Ctrl+K 时空命令面板（Omnibox）——U07 双栏检索台与可点击语法胶囊。
 *
 * 交互闭环（任务卡 C03 验收 + U07 升级）：
 *   ↑/↓ 循环选择 · Enter 打开 · Ctrl+Enter 定位所在目录 · Tab 加入上下文（证据）篮 ·
 *   Esc 关闭（根节点挂 data-esc-layer="open"，App Esc 阶梯顶部统一兜底）。
 * U07 交付（长任务卡 §4 U07，commandPaletteGrammar/commandPaletteResults 既定口径不变）：
 *   - 弹窗入场 `glx-popover-in` 柔和缩放淡入（遮罩 `glx-backdrop-in`；均为既有已登记类）；
 *   - 输入框右侧「语法 Token 彩色微标签」：parsePaletteTokens 纯函数拆解当前查询的
 *     语法意图 token（date/type/status/in），点 `×` 一键移除（removePaletteTokenAt）；
 *     语法未收录的 @词 / status 值诚实标注「未识别」（冻结口径：回退为关键词检索）；
 *   - 输入栏下方常驻单行「快捷语法胶囊」：@今天 / @近7天 / status:待拍板 / type:md /
 *     type:svg，点击即补全查询（togglePaletteSuggestion 只改 query 字符串并走
 *     onQueryChange → setQuery 正常防抖与过期响应丢弃纪律，不绕过任何取数状态）；
 *   - 桌面宽屏（lg ≥1024px）双栏：左结果列表 60% + 右实时预览窗 40%——完整路径、
 *     版本短码徽标、待拍板徽标、命中正文高亮段落、SVG 微缩图（懒加载 URL 直拼，
 *     键盘游走零 fetch / 零 IO 竞态）与快捷动作提示；窄屏保持原单列体验。
 * 渲染细节（吸收 quiet-md search.rs）：
 *   - 空查询直出「最近浏览」Top 20（由 Hook 组装，本组件不关心数据源）；
 *   - 命中摘要：首个命中词前 16 字起窗口、≤2 行、窗口内命中词**全量**高亮
 *     （buildSnippet 纯函数分段，SSR 安全）；
 *   - 滚动条落于右侧 padding 槽内（`.glx-palette-scroll`），不遮挡正文；
 *   - 底栏常驻极淡键位提示。
 * 呼出即输入（<16ms 口径）：open() 只置布尔位，本组件无 IO、无 await、无延迟挂载；
 * input 同帧 focus，胶囊行/token 徽标为纯内存派生（useMemo）。
 */
export interface CommandPaletteProps {
  isOpen: boolean;
  query: string;
  items: PaletteItem[];
  /** 全文层加载中（本地层已即时刷新，微进度提示） */
  searching: boolean;
  onQueryChange: (q: string) => void;
  onClose: () => void;
  /** Enter：打开文件（阅读器） */
  onOpenFile: (item: PaletteItem) => void;
  /** Shift+Enter（V08）：打开文件版本时光机 */
  onOpenTimeMachine?: (item: PaletteItem) => void;
  /** Ctrl+Enter：定位所在目录（资源管理器高亮） */
  onLocate: (item: PaletteItem) => void;
  /** Tab：加入上下文（证据）篮 */
  onAddToBasket: (item: PaletteItem) => void;
  /** kind=action 条目执行（跳今天 / 证据篮 / 切换工作区 / 定位根目录） */
  onRunAction: (item: PaletteItem) => void;
  /** V08：内存文件全量索引（零 IO 同步派生版本号 vN·最新 / L4A 摘要 / 大纲 / 更新时刻，彻底消除 f_ 裸哈希） */
  files?: FileRecord[];
}

/* ═══════════════════════════════════════════════════════════════════════════
   U07 · 纯函数层（无 DOM 依赖，node:test 直测；按任务卡 §2.1.4 巨石防膨胀纪律，
   语法胶囊解析与右预览派生一律抽纯函数、测试直接 import 组件模块导出面）
   ═══════════════════════════════════════════════════════════════════════════ */

/** 语法 token 意图分类（keyword = 普通检索词） */
export type PaletteTokenKind = 'date' | 'type' | 'status' | 'in' | 'keyword';

/** 输入框右侧微标签的语法 token 模型：原文 / 偏移 / 解析成败（诚实标注） */
export interface PaletteToken {
  kind: PaletteTokenKind;
  /** 原文 token（含 @ / 前缀，保留用户输入大小写） */
  text: string;
  /** 在原始查询字符串中的起始偏移（一键移除的定位依据） */
  start: number;
  /** 是否被现行冻结语法口径接受（未收录的 @词 / status 值为 false，诚实回退关键词） */
  parsed: boolean;
  /** 解析值：date=YYYY-MM-DD / type=小写格式 / status=待拍板 / in=事项名 / keyword=原文 */
  value?: string;
}

/**
 * 查询字符串 → token 序列（与 commandPaletteGrammar.parsePaletteQuery 的既定口径
 * 逐分支对齐：@词相对/绝对日期、type:/status:/in: 前缀大小写无关；未收录值
 * parsed=false 诚实标注，不吞词、不造解析）。
 */
export function parsePaletteTokens(raw: string, now: Date = new Date()): PaletteToken[] {
  const tokens: PaletteToken[] = [];
  const re = /\S+/g;
  for (let m = re.exec(raw); m; m = re.exec(raw)) {
    const token = m[0];
    const start = m.index;
    if (token.startsWith('@') && token.length > 1) {
      const day = resolveRelativeDay(token.slice(1), now);
      tokens.push({
        kind: 'date',
        text: token,
        start,
        parsed: day !== null,
        value: day ?? undefined,
      });
      continue;
    }
    const lower = token.toLowerCase();
    if (lower.startsWith('type:') && lower.length > 5) {
      tokens.push({ kind: 'type', text: token, start, parsed: true, value: lower.slice(5) });
      continue;
    }
    if (lower.startsWith('status:')) {
      const v = lower.slice(7);
      const parsed = v === '待拍板' || v === 'pending' || v === 'p0' || v === 'p1';
      tokens.push({
        kind: 'status',
        text: token,
        start,
        parsed,
        value: parsed ? '待拍板' : undefined,
      });
      continue;
    }
    if (lower.startsWith('in:') && lower.length > 3) {
      tokens.push({ kind: 'in', text: token, start, parsed: true, value: token.slice(3) });
      continue;
    }
    tokens.push({ kind: 'keyword', text: token, start, parsed: true, value: token });
  }
  return tokens;
}

/** 按偏移一键移除 token（含该偏移的空白分隔词），并收敛多余空白；偏移越界/落空白原样返回 */
export function removePaletteTokenAt(raw: string, start: number): string {
  if (start < 0 || start >= raw.length) return raw;
  if (/\s/.test(raw[start])) return raw;
  let s = start;
  while (s > 0 && !/\s/.test(raw[s - 1])) s--;
  let e = start;
  while (e < raw.length && !/\s/.test(raw[e])) e++;
  return (raw.slice(0, s) + raw.slice(e)).replace(/\s{2,}/g, ' ').trim();
}

/** 查询中是否已含该 token（整词精确匹配：`type:md` 不命中 `type:mdx`） */
export function hasPaletteToken(query: string, token: string): boolean {
  if (!token) return false;
  return query.split(/\s+/).includes(token);
}

/**
 * 语法胶囊「点击即补全 / 再点移除」：只改 query 字符串（调用方经 onQueryChange →
 * setQuery 走 130ms 全文层防抖与 fetchSeq 过期丢弃纪律），绝不绕过取数状态。
 */
export function togglePaletteSuggestion(query: string, token: string): string {
  if (hasPaletteToken(query, token)) {
    const re = /\S+/g;
    for (let m = re.exec(query); m; m = re.exec(query)) {
      if (m[0] === token) return removePaletteTokenAt(query, m.index);
    }
    return query;
  }
  const base = query.trim();
  return base ? `${base} ${token}` : token;
}

/** 微标签色调（语义只用 --stage-ink-* 六色双层家族：色块/描边取 graphic、文字取 -text 深档） */
export type PaletteTokenTone = 'blueprint' | 'plan' | 'decision' | 'deliver' | 'anomaly' | 'neutral';

/** kind（+type 值）→ 色调：时间=蓝图蓝、格式=交付绿（svg= anomaly 玫红）、拍板=决断琥珀、事项=司辰紫 */
export function paletteTokenTone(kind: PaletteTokenKind, value?: string): PaletteTokenTone {
  if (kind === 'date') return 'blueprint';
  if (kind === 'status') return 'decision';
  if (kind === 'type') return value === 'svg' ? 'anomaly' : 'deliver';
  if (kind === 'in') return 'plan';
  return 'neutral';
}

/** 色调 → 文字色（浅玻璃 AA 深档，index.css 六色双层 -text 出口） */
const TONE_TEXT: Record<PaletteTokenTone, string> = {
  blueprint: 'var(--stage-ink-blueprint-text)',
  plan: 'var(--stage-ink-plan-text)',
  decision: 'var(--stage-ink-decision-text)',
  deliver: 'var(--stage-ink-deliver-text)',
  anomaly: 'var(--stage-ink-anomaly-text)',
  neutral: 'var(--ink-soft)',
};

/** 色调 → 图形色（tint 底/描边 color-mix 原值；neutral 不着色相只做次文灰） */
const TONE_GRAPHIC: Record<PaletteTokenTone, string> = {
  blueprint: 'var(--stage-ink-blueprint)',
  plan: 'var(--stage-ink-plan)',
  decision: 'var(--stage-ink-decision)',
  deliver: 'var(--stage-ink-deliver)',
  anomaly: 'var(--stage-ink-anomaly)',
  neutral: 'var(--ink-soft)',
};

/** 快捷语法胶囊（输入栏下方常驻单行；token 即点击补全进查询的原文） */
export interface PaletteGrammarSuggestion {
  /** 胶囊展示文本 */
  label: string;
  /** 点击补全进查询的 token（再点同 token 即移除） */
  token: string;
  kind: 'date' | 'status' | 'type';
  tone: Exclude<PaletteTokenTone, 'neutral'>;
  /** 悬停自解释（降低语法记忆成本） */
  hint: string;
}

export const PALETTE_GRAMMAR_SUGGESTIONS: readonly PaletteGrammarSuggestion[] = [
  {
    label: '@今天',
    token: '@今天',
    kind: 'date',
    tone: 'blueprint',
    hint: '只看今天观测到的文件（@日期 过滤，可换 @昨天 / @N天前 / @YYYY-MM-DD）',
  },
  {
    label: '@近7天',
    token: '@近7天',
    kind: 'date',
    tone: 'blueprint',
    hint: '观测日过滤示例——现行语法口径暂无区间档，该词将诚实回退为关键词检索',
  },
  {
    label: 'status:待拍板',
    token: 'status:待拍板',
    kind: 'status',
    tone: 'decision',
    hint: '只看有 P0/P1 待拍板决定的文件',
  },
  {
    label: 'type:md',
    token: 'type:md',
    kind: 'type',
    tone: 'deliver',
    hint: '只看 Markdown 文档（type: 格式过滤，可叠加多枚取交集）',
  },
  {
    label: 'type:svg',
    token: 'type:svg',
    kind: 'type',
    tone: 'anomaly',
    hint: '只看 SVG 矢量稿（type: 格式过滤）',
  },
];

/** 版本短码诚实展示（revisionId 超 12 字符截断加省略号；无 seq 数据绝不伪造 vN） */
export function shortRevisionId(revisionId: string): string {
  return revisionId.length > 12 ? `${revisionId.slice(0, 12)}…` : revisionId;
}

/** V08：识别内部裸哈希标识（如 f_0114325c93... / rev_0114325c93...），杜绝直接裸露到用户界面 */
export function isOpaqueInternalHash(raw: string | null | undefined): boolean {
  if (!raw) return false;
  const trimmed = raw.trim();
  return /^(?:f|rev|doc|file)_[0-9a-f]{8,}$/i.test(trimmed) || /^[0-9a-f]{16,}$/i.test(trimmed);
}

/** V08：剥离裸内部哈希标签（用户可读标题/副标题净化） */
export function sanitizePaletteDisplayText(
  raw: string | null | undefined,
  fallback = ''
): string {
  if (!raw) return fallback;
  const trimmed = raw.trim();
  if (!trimmed || isOpaqueInternalHash(trimmed)) return fallback;
  return trimmed.replace(/\b(?:f|rev|doc)_[0-9a-f]{8,}\b/gi, '').replace(/\s{2,}/g, ' ').trim() || fallback;
}

/** V08：为文件条目派生人类可读版本号标签（vN · 最新 / vN / 优雅回退，绝不泄露 f_ 裸哈希） */
export function formatPaletteVersionBadge(
  item: PaletteItem,
  file?: FileRecord
): string | null {
  if (item.kind === 'action') return null;
  if (file && file.revisions.length > 0) {
    const matched =
      (item.revisionId && file.revisions.find((r) => r.revision_id === item.revisionId)) ||
      file.revisions.find((r) => r.revision_id === file.current_revision_id) ||
      file.revisions[0];
    if (matched) {
      const isLatest = matched.revision_id === file.current_revision_id;
      return isLatest ? `v${matched.versionNumber} · 最新` : `v${matched.versionNumber}`;
    }
  }
  if (!item.revisionId) return null;
  if (isOpaqueInternalHash(item.revisionId)) return '当前版本';
  return shortRevisionId(item.revisionId);
}

const COVERAGE_LABELS: Record<string, string> = {
  full_text: '全文命中',
  svg_text: 'SVG 文本命中',
  pdf_page_text: 'PDF 页文本命中',
  office_structured: 'Office 结构化命中',
  filename_only: '文件名命中',
  decision: '决策命中',
};

const MATCH_STRATEGY_LABELS: Record<string, string> = {
  exact_code: '编号精确',
  filename_match: '文件名命中',
  bigram_phrase_verified: '短语校验命中',
};

/** 右预览窗渲染模型（PaletteItem → 视图字段；无数据字段留 null，诚实空态不伪造） */
export interface PalettePreviewModel {
  isAction: boolean;
  title: string;
  /** 完整路径（relativePath 优先，subtitle 兜底，净除 f_ 裸哈希） */
  path: string | null;
  formatBadge: string;
  /** 当前版本短码（U07 兼容字段：revisionId 截断展示） */
  revisionShort: string | null;
  /** V08：人类可读版本徽标（如「v4 · 最新」，彻底隐藏 f_/rev_ 裸哈希） */
  humanVersionLabel: string | null;
  /** V08：所属专项名（taskPackageOf 真实派生） */
  packageName: string | null;
  /** V08：更新相对时刻（observed_at 真实派生） */
  updatedLabel: string | null;
  /** V08：已排空的 L4A 摘要或核心结论首句（无则 null 优雅回退） */
  l4aSummary: string | null;
  /** V08：文档大纲条目（最多 4 项，来自正文 Markdown 标题） */
  outlineHeadings: string[];
  pendingDecisions: number;
  /** SVG 微缩图地址（仅 svg 格式且有 revisionId；懒加载 URL 直拼，选中变化零 fetch） */
  thumbnailUrl: string | null;
  /** 命中正文高亮分段（snippetText 存在时；≤2 行 / 200 字窗口口径与列表一致） */
  snippet: SnippetResult | null;
  /** 无正文摘要时的诚实说明（本地层命中不带 snippet） */
  snippetFallback: string | null;
  coverageLabel: string | null;
  matchStrategyLabel: string | null;
  sourceWorkspace: { name: string; rootKey: string } | null;
  /** 快捷动作提示（Enter 打开 / Ctrl+Enter 定位 / Tab 入证据篮；动作条目为 Enter 执行） */
  hints: string[];
}

/** 选中条目 → 右预览窗模型（纯派生，SSR 安全；传入可选 FileRecord 启用 V08 L4A 富预览与版本号） */
export function palettePreviewModel(
  item: PaletteItem,
  query: string,
  file?: FileRecord
): PalettePreviewModel {
  const isAction = item.kind === 'action';
  const isSvg = item.format?.toLowerCase() === 'svg';
  const rawPath = item.relativePath ?? file?.relative_path ?? item.subtitle ?? null;
  const cleanPath = rawPath ? sanitizePaletteDisplayText(rawPath, '') || null : null;
  const cleanTitle = sanitizePaletteDisplayText(item.title, file?.title ?? '未命名文档');

  const currentRev =
    file && file.revisions.length > 0
      ? (item.revisionId && file.revisions.find((r) => r.revision_id === item.revisionId)) ||
        file.revisions.find((r) => r.revision_id === file.current_revision_id) ||
        file.revisions[0]
      : undefined;

  const packageName =
    !isAction && cleanPath
      ? (() => {
          const pkg = taskPackageOf(cleanPath);
          return pkg.id === '__root__' ? '工作区根目录' : pkg.name;
        })()
      : null;

  const updatedLabel = currentRev?.observed_at
    ? formatRelativeObservedAt(currentRev.observed_at)
    : null;

  const l4aSummary =
    !isAction && file
      ? (() => {
          const extracted = extractCoreSummary(file);
          if (extracted && !isOpaqueInternalHash(extracted)) return extracted;
          const note = currentRev?.summaryNote?.trim();
          if (note && !isOpaqueInternalHash(note)) return note;
          return null;
        })()
      : null;

  const outlineHeadings =
    !isAction && currentRev?.markdownContent
      ? parseMarkdownOutline(currentRev.markdownContent)
          .slice(0, 4)
          .map((s) => s.title.trim())
          .filter(Boolean)
      : [];

  return {
    isAction,
    title: cleanTitle,
    path: cleanPath,
    formatBadge: formatBadge(item.format),
    revisionShort: item.revisionId ? shortRevisionId(item.revisionId) : null,
    humanVersionLabel: formatPaletteVersionBadge(item, file),
    packageName,
    updatedLabel,
    l4aSummary,
    outlineHeadings,
    pendingDecisions: item.pendingDecisions ?? 0,
    thumbnailUrl: isSvg && item.revisionId ? revisionThumbnailUrl(item.revisionId) : null,
    snippet: item.snippetText ? buildSnippet(item.snippetText, query) : null,
    snippetFallback:
      !isAction && !item.snippetText && !l4aSummary
        ? '本地索引命中（路径/标题）——正文摘要由全文检索层提供'
        : null,
    coverageLabel: item.coverage ? COVERAGE_LABELS[item.coverage] ?? null : null,
    matchStrategyLabel: item.matchStrategy
      ? MATCH_STRATEGY_LABELS[item.matchStrategy] ?? null
      : null,
    sourceWorkspace: item.sourceWorkspace ?? null,
    hints: isAction
      ? ['Enter 执行动作', 'Esc 关闭']
      : ['Enter 打开', 'Ctrl+Enter 定位目录', 'Tab 加入证据篮'],
  };
}

/* ═══════════════════════════════════════════════════════════════════════════
   展示组件
   ═══════════════════════════════════════════════════════════════════════════ */

function formatBadge(format?: string): string {
  if (!format) return '–';
  return format.toUpperCase();
}

/** 摘要高亮渲染（≤2 行窗口；line-clamp 兜底 CSS 双保险） */
function SnippetView({ text, query }: { text: string; query: string }): React.ReactElement {
  const snippet = useMemo(() => buildSnippet(text, query), [text, query]);
  return (
    <div className="glx-clamp-2 text-[12px] leading-5 text-[color:var(--ink-soft)] whitespace-pre-wrap break-all">
      {snippet.clippedHead ? <span className="opacity-70">…</span> : null}
      {snippet.segments.map((seg: SnippetSegment, i) =>
        seg.hit ? (
          <mark
            key={i}
            className="bg-transparent text-[color:var(--accent-iris-ink)] font-semibold"
          >
            {seg.text}
          </mark>
        ) : (
          <span key={i}>{seg.text}</span>
        )
      )}
      {snippet.clippedTail ? <span className="opacity-70">…</span> : null}
    </div>
  );
}

/** 输入框右侧语法 Token 彩色微标签（点 × 一键移除；未识别诚实标注） */
function TokenChip({
  token,
  onRemove,
}: {
  token: PaletteToken;
  onRemove: () => void;
}): React.ReactElement {
  const tone = token.parsed ? paletteTokenTone(token.kind, token.value) : 'neutral';
  const graphic = TONE_GRAPHIC[tone];
  return (
    <span
      data-palette-token={token.text}
      data-palette-token-parsed={token.parsed ? 'true' : 'false'}
      title={
        token.parsed
          ? `已解析：${token.value ?? token.text}（点 × 移除）`
          : '未识别语法——按关键词诚实检索，点 × 移除'
      }
      className="inline-flex items-center gap-1 rounded-full py-[2px] pl-2 pr-1 text-[11px] font-medium leading-none"
      style={{
        color: TONE_TEXT[tone],
        background: `color-mix(in srgb, ${graphic} ${token.parsed ? 12 : 6}%, transparent)`,
        boxShadow: `inset 0 0 0 1px color-mix(in srgb, ${graphic} ${
          token.parsed ? 45 : 26
        }%, transparent)`,
      }}
    >
      {token.text}
      {!token.parsed ? <span className="text-[color:var(--ink-soft)]">未识别</span> : null}
      <button
        type="button"
        aria-label={`移除语法标签 ${token.text}`}
        data-palette-token-remove="true"
        onMouseDown={(e) => e.preventDefault()}
        onClick={onRemove}
        className="flex h-[16px] w-[16px] items-center justify-center rounded-full leading-none transition-opacity hover:opacity-70"
        style={{ color: 'inherit' }}
      >
        ×
      </button>
    </span>
  );
}

/** V08 右实时富预览窗（lg ≥1024px 双栏 40% 列）：版本号 / 专项 / 更新时刻 / L4A 摘要 / 大纲 / 缩略图 / 一键快捷动作 */
function PreviewPane({
  model,
  item,
  onOpen,
  onOpenTimeMachine,
  onAddToBasket,
}: {
  model: PalettePreviewModel;
  item: PaletteItem;
  onOpen: () => void;
  onOpenTimeMachine?: () => void;
  onAddToBasket: () => void;
}): React.ReactElement {
  return (
    <div className="flex h-full flex-col gap-2.5" data-command-palette-preview-body="true">
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge variant="outline" size="sm" className="font-mono uppercase">
          {model.formatBadge}
        </Badge>
        {model.humanVersionLabel ? (
          <Badge
            variant="brand"
            size="sm"
            data-command-palette-revision="true"
            title={`当前版本：${model.humanVersionLabel}`}
          >
            {model.humanVersionLabel}
          </Badge>
        ) : null}
        {model.pendingDecisions > 0 ? (
          <Badge variant="warning" size="sm">
            待拍板 {model.pendingDecisions}
          </Badge>
        ) : null}
        {model.coverageLabel ? (
          <span className="text-[10.5px] text-muted-foreground">{model.coverageLabel}</span>
        ) : null}
        {model.matchStrategyLabel ? (
          <Badge variant="secondary" size="sm">
            {model.matchStrategyLabel}
          </Badge>
        ) : null}
      </div>

      <div className="space-y-1">
        <div className="text-[14px] font-semibold leading-snug text-foreground">{model.title}</div>
        {model.path ? (
          <div
            data-command-palette-preview-path={model.path}
            className="break-all font-mono text-[11px] leading-4 text-muted-foreground"
          >
            {model.path}
          </div>
        ) : null}
      </div>

      {/* V08：所属专项与最近更新时刻元信息条 */}
      {(model.packageName || model.updatedLabel) && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border/70 bg-muted/40 px-2.5 py-1.5 text-[11px] text-muted-foreground">
          {model.packageName ? (
            <span className="inline-flex items-center gap-1 min-w-0 truncate">
              <Layers className="size-3 shrink-0 text-[color:var(--accent-iris-deep)]" aria-hidden="true" />
              <span className="truncate font-medium text-foreground/90">{model.packageName}</span>
            </span>
          ) : null}
          {model.packageName && model.updatedLabel ? (
            <span aria-hidden="true" className="opacity-40">·</span>
          ) : null}
          {model.updatedLabel ? (
            <span className="inline-flex items-center gap-1 shrink-0 font-mono tabular-nums">
              <Clock className="size-3 shrink-0" aria-hidden="true" />
              <span>{model.updatedLabel}</span>
            </span>
          ) : null}
        </div>
      )}

      {model.thumbnailUrl ? (
        <img
          src={model.thumbnailUrl}
          alt={`${model.title} SVG 微缩图`}
          loading="lazy"
          decoding="async"
          data-command-palette-thumb="true"
          className="max-h-[160px] w-auto max-w-full self-start rounded-[10px] border border-border/70 bg-background/80 p-1"
        />
      ) : null}

      {/* V08：已排空的 L4A 摘要卡（无摘要时优雅回退，不造数） */}
      {model.l4aSummary ? (
        <div
          data-command-palette-l4a-summary="true"
          className="rounded-lg border border-border/75 bg-muted/35 p-2.5 space-y-1"
        >
          <div className="flex items-center gap-1 text-[10px] font-semibold tracking-wider text-[color:var(--accent-iris-ink)]">
            <Sparkles className="size-3 shrink-0" aria-hidden="true" />
            <span>智能摘要</span>
          </div>
          <p className="text-[12px] leading-5 text-foreground/90 line-clamp-3">
            {model.l4aSummary}
          </p>
        </div>
      ) : null}

      {/* V08：文档大纲条目（最多 4 项） */}
      {model.outlineHeadings.length > 0 ? (
        <div data-command-palette-outline="true" className="space-y-1">
          <div className="text-[10px] font-medium tracking-wider text-muted-foreground">文档大纲</div>
          <ul className="space-y-0.5 text-[11.5px] text-muted-foreground">
            {model.outlineHeadings.map((heading, idx) => (
              <li key={`${heading}-${idx}`} className="flex items-center gap-1.5 truncate">
                <span className="size-1 rounded-full bg-[color:var(--accent-iris)] shrink-0" aria-hidden="true" />
                <span className="truncate">{heading}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {model.snippet ? (
        <div
          data-command-palette-preview-snippet="true"
          className="rounded-lg border border-border/60 bg-background/60 p-2 whitespace-pre-wrap break-all text-[12px] leading-5 text-muted-foreground"
        >
          {model.snippet.clippedHead ? <span className="opacity-70">…</span> : null}
          {model.snippet.segments.map((seg: SnippetSegment, i) =>
            seg.hit ? (
              <mark
                key={i}
                className="bg-transparent text-[color:var(--accent-iris-ink)] font-semibold"
              >
                {seg.text}
              </mark>
            ) : (
              <span key={i}>{seg.text}</span>
            )
          )}
          {model.snippet.clippedTail ? <span className="opacity-70">…</span> : null}
        </div>
      ) : model.snippetFallback ? (
        <div className="text-[11px] leading-4 text-muted-foreground">
          {model.snippetFallback}
        </div>
      ) : null}

      {model.sourceWorkspace ? (
        <div
          className="inline-flex items-center gap-1 truncate rounded-md bg-[color:color-mix(in_srgb,var(--accent-iris)_10%,transparent)] px-2 py-1 text-[10.5px] text-muted-foreground"
          title={`来源参考工作区：${model.sourceWorkspace.name}（${model.sourceWorkspace.rootKey.slice(0, 8)}）`}
        >
          <FolderOpen className="size-3 shrink-0" aria-hidden="true" />
          <span className="truncate">{model.sourceWorkspace.name}</span>
        </div>
      ) : null}

      {/* V08：一键快捷动作按钮 + 键位提示 */}
      <div
        data-command-palette-preview-hints="true"
        className="mt-auto space-y-2 border-t border-border/75 pt-2.5"
      >
        {!model.isAction && item.kind === 'file' && (
          <div className="flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={onOpen}
              className="inline-flex cursor-pointer items-center gap-1 rounded-md border border-border bg-card px-2 py-1 text-[11px] font-medium text-foreground hover:bg-accent"
            >
              <span>打开阅读</span>
              <Kbd className="h-4 px-1 text-[9.5px]">Enter</Kbd>
            </button>
            {onOpenTimeMachine && (
              <button
                type="button"
                data-palette-action-timemachine="true"
                onMouseDown={(e) => e.preventDefault()}
                onClick={onOpenTimeMachine}
                className="inline-flex cursor-pointer items-center gap-1 rounded-md border border-border bg-card px-2 py-1 text-[11px] font-medium text-foreground hover:bg-accent"
              >
                <span>时光机</span>
                <Kbd className="h-4 px-1 text-[9.5px]">⇧Enter</Kbd>
              </button>
            )}
            <button
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={onAddToBasket}
              className="inline-flex cursor-pointer items-center gap-1 rounded-md border border-border bg-card px-2 py-1 text-[11px] font-medium text-foreground hover:bg-accent"
            >
              <span>进证据篮</span>
              <Kbd className="h-4 px-1 text-[9.5px]">Tab</Kbd>
            </button>
          </div>
        )}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-muted-foreground">
          {model.hints.map((h) => (
            <span key={h}>{h}</span>
          ))}
        </div>
      </div>
    </div>
  );
}

export function CommandPalette(props: CommandPaletteProps): React.ReactElement | null {
  const { isOpen, query, items, searching, onQueryChange, onClose, files } = props;
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const fileById = useMemo(() => {
    const map = new Map<string, FileRecord>();
    if (files) {
      for (const f of files) map.set(f.file_id, f);
    }
    return map;
  }, [files]);

  // 打开即聚焦（呼出 <16ms 的可输入口径）；查询变化时重置选中到首项
  useEffect(() => {
    if (isOpen) {
      inputRef.current?.focus();
      setSelectedIndex(0);
    }
  }, [isOpen]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [items]);

  // 键盘连续上下选择时选中行始终可见（零遮挡：block:'nearest'）
  useEffect(() => {
    if (!isOpen || !listRef.current) return;
    const el = listRef.current.querySelector<HTMLElement>('[data-selected="true"]');
    el?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex, isOpen]);

  // U07 + V08：输入框右侧语法 token 微标签 + 右预览窗 L4A 富预览模型（纯内存同步派生，零 IO）
  const syntaxTokens = useMemo(
    () => (isOpen ? parsePaletteTokens(query).filter((t) => t.kind !== 'keyword') : []),
    [isOpen, query]
  );
  const selectedItem = items[selectedIndex];
  const selectedFile =
    selectedItem && selectedItem.fileId ? fileById.get(selectedItem.fileId) : undefined;
  const preview = useMemo(
    () =>
      isOpen && selectedItem
        ? palettePreviewModel(selectedItem, query, selectedFile)
        : null,
    [isOpen, selectedItem, query, selectedFile]
  );

  if (!isOpen) return null;

  const clampIndex = (idx: number): number => {
    if (items.length === 0) return 0;
    return (idx + items.length) % items.length;
  };

  const runItem = (item: PaletteItem): void => {
    if (item.kind === 'action') props.onRunAction(item);
    else if (item.fileId) props.onOpenFile(item);
  };

  const handleKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex((idx) => clampIndex(idx + 1));
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex((idx) => clampIndex(idx - 1));
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      const item = items[selectedIndex];
      if (!item) return;
      if (e.shiftKey && item.kind === 'file' && props.onOpenTimeMachine) {
        props.onOpenTimeMachine(item);
        onClose();
        return;
      }
      if (e.ctrlKey || e.metaKey) {
        // Ctrl+Enter：定位所在目录（文件条目 → 资源管理器高亮；动作条目按执行处理）
        if (item.kind === 'file') props.onLocate(item);
        else props.onRunAction(item);
        return;
      }
      runItem(item);
      onClose();
      return;
    }
    if (e.key === 'Tab') {
      e.preventDefault();
      const item = items[selectedIndex];
      if (item && item.kind === 'file') props.onAddToBasket(item);
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="全局命令与时空检索"
      data-esc-layer="open"
      data-command-palette="open"
      className="glx-backdrop-in fixed inset-0 z-[90] flex items-start justify-center bg-[color:var(--ink-anchor)]/40 dark:bg-black/62 pt-[10vh] backdrop-blur-sm"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      {/* V08：coss Command 外灰槽 + 内亮板 CommandPanel 双栏富预览台 */}
      <div className="glass-pop glx-popover-in flex w-[min(680px,92vw)] flex-col overflow-hidden rounded-2xl border border-border bg-muted/90 dark:bg-popover/95 p-1.5 shadow-2xl lg:w-[min(1040px,92vw)]">
        {/* 外灰槽顶部：搜索框 + Token 微标签 + 常驻语法胶囊行 */}
        <div className="px-3 pb-2.5 pt-2">
          <div className="flex items-center gap-2">
            <Search className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => onQueryChange(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="搜索文件与正文 · @昨天 type:pdf status:待拍板 in:事项名"
              spellCheck={false}
              autoComplete="off"
              data-command-palette-input="true"
              className="min-w-0 flex-1 bg-transparent text-[15px] text-foreground outline-none placeholder:text-muted-foreground/80"
            />
            {syntaxTokens.length > 0 ? (
              <div
                className="flex max-w-[52%] shrink-0 flex-wrap items-center justify-end gap-1"
                data-command-palette-tokens="true"
                aria-label="已解析语法标签"
              >
                {syntaxTokens.map((t) => (
                  <TokenChip
                    key={`${t.start}:${t.text}`}
                    token={t}
                    onRemove={() => onQueryChange(removePaletteTokenAt(query, t.start))}
                  />
                ))}
              </div>
            ) : null}
          </div>
          {/* U07：快捷语法胶囊（常驻单行；点击即补全 → 再点即移除，走 onQueryChange 正常纪律） */}
          <div
            className="mt-2 flex flex-wrap items-center gap-1.5"
            data-command-palette-grammar="true"
            role="group"
            aria-label="快捷语法胶囊"
          >
            {PALETTE_GRAMMAR_SUGGESTIONS.map((s) => {
              const active = hasPaletteToken(query, s.token);
              const graphic = TONE_GRAPHIC[s.tone];
              return (
                <button
                  key={s.token}
                  type="button"
                  data-palette-suggest={s.token}
                  aria-pressed={active}
                  title={s.hint}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => onQueryChange(togglePaletteSuggestion(query, s.token))}
                  className="glx-pill-tactile cursor-pointer rounded-full px-2 py-[3px] text-[11px] font-medium leading-none"
                  style={{
                    color: TONE_TEXT[s.tone],
                    background: `color-mix(in srgb, ${graphic} ${active ? 16 : 8}%, transparent)`,
                    boxShadow: `inset 0 0 0 1px color-mix(in srgb, ${graphic} ${
                      active ? 55 : 32
                    }%, transparent)`,
                  }}
                >
                  {s.label}
                </button>
              );
            })}
            <span className="ml-auto shrink-0 text-[11px] text-muted-foreground">
              点击补全 · 再点移除
            </span>
          </div>
        </div>

        {/* V08 内亮板 CommandPanel：lg ≥1024px 左结果列表 60%（ScrollArea） + 右实时富预览 40% */}
        <CommandPanel className="flex flex-col overflow-hidden lg:flex-row">
          <ScrollArea scrollFade className="max-h-[52vh] w-full lg:w-[60%] lg:shrink-0">
            <div
              ref={listRef}
              role="listbox"
              aria-label="检索结果"
              data-command-palette-list="true"
              className="glx-palette-scroll px-2 py-2"
            >
              {items.length === 0 ? (
                <Empty className="py-10">
                  <EmptyHeader>
                    <EmptyMedia variant="icon">
                      <FileText className="size-4" />
                    </EmptyMedia>
                    <EmptyTitle>{searching ? '正在检索正文…' : '没有匹配结果'}</EmptyTitle>
                    <EmptyDescription>
                      {searching
                        ? '本地目录命中将即时并入全文结果'
                        : '试试 @昨天、type:pdf 或 status:待拍板'}
                    </EmptyDescription>
                  </EmptyHeader>
                </Empty>
              ) : (
                items.map((item, i) => {
                  const selected = i === selectedIndex;
                  const rowFile = item.fileId ? fileById.get(item.fileId) : undefined;
                  const cleanTitle = sanitizePaletteDisplayText(
                    item.title,
                    rowFile?.title ?? '未命名文档'
                  );
                  const cleanSubtitle = sanitizePaletteDisplayText(
                    item.subtitle,
                    rowFile?.relative_path ?? ''
                  );
                  return (
                    <div
                      key={item.key}
                      role="option"
                      aria-selected={selected}
                      data-selected={selected || undefined}
                      data-palette-kind={item.kind}
                      onMouseEnter={() => setSelectedIndex(i)}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => {
                        setSelectedIndex(i);
                        runItem(item);
                        onClose();
                      }}
                      className={[
                        'cursor-pointer rounded-lg px-3 py-2 transition-colors',
                        selected
                          ? 'bg-[color:color-mix(in_srgb,var(--accent-iris)_12%,transparent)]'
                          : 'hover:bg-accent/75',
                      ].join(' ')}
                    >
                      <div className="flex items-center gap-2">
                        {item.kind === 'file' ? (
                          <span className="min-w-[34px] rounded px-1 py-[1px] text-center font-mono text-[10px] font-semibold tracking-wide text-muted-foreground ring-1 ring-border">
                            {formatBadge(item.format)}
                          </span>
                        ) : (
                          <span className="min-w-[34px] text-center text-[12px]">▸</span>
                        )}
                        <span className="truncate text-[13.5px] font-medium text-foreground">
                          {cleanTitle}
                        </span>
                        {item.pendingDecisions ? (
                          <Badge variant="warning" size="sm" className="shrink-0">
                            待拍板 {item.pendingDecisions}
                          </Badge>
                        ) : null}
                        {item.matchStrategy === 'exact_code' ? (
                          <Badge variant="outline" size="sm" className="shrink-0">
                            编号精确
                          </Badge>
                        ) : null}
                        {item.sourceWorkspace ? (
                          <span
                            className="max-w-[160px] truncate rounded bg-[color:color-mix(in_srgb,var(--accent-iris)_10%,transparent)] px-1.5 py-[1px] text-[10px] text-muted-foreground"
                            title={`来源参考工作区：${item.sourceWorkspace.name}（${item.sourceWorkspace.rootKey.slice(0, 8)}）`}
                          >
                            📁 {item.sourceWorkspace.name}
                          </span>
                        ) : null}
                        {cleanSubtitle ? (
                          <span className="ml-auto shrink-0 max-w-[38%] truncate pl-2 font-mono text-[11px] text-muted-foreground">
                            {cleanSubtitle}
                          </span>
                        ) : null}
                      </div>
                      {item.kind === 'file' && item.snippetText ? (
                        <div className="mt-1 pl-[42px]">
                          <SnippetView text={item.snippetText} query={query} />
                        </div>
                      ) : null}
                    </div>
                  );
                })
              )}
            </div>
          </ScrollArea>

          {/* V08 右实时富预览窗：随选中实时展示版本/专项/更新时刻/L4A摘要/大纲/缩略图/快捷动作 */}
          <aside
            data-command-palette-preview="true"
            aria-label="命中预览"
            className="hidden max-h-[52vh] flex-col overflow-y-auto overscroll-contain border-t border-border/80 bg-muted/20 px-3.5 py-3 lg:flex lg:w-[40%] lg:border-l lg:border-t-0"
          >
            {preview && selectedItem ? (
              <PreviewPane
                model={preview}
                item={selectedItem}
                onOpen={() => {
                  runItem(selectedItem);
                  onClose();
                }}
                onOpenTimeMachine={
                  props.onOpenTimeMachine && selectedItem.kind === 'file'
                    ? () => {
                        props.onOpenTimeMachine?.(selectedItem);
                        onClose();
                      }
                    : undefined
                }
                onAddToBasket={() => {
                  if (selectedItem.kind === 'file') props.onAddToBasket(selectedItem);
                }}
              />
            ) : (
              <div
                data-command-palette-preview-empty="true"
                className="px-1 py-6 text-center text-[12px] text-muted-foreground"
              >
                暂无选中结果
              </div>
            )}
          </aside>
        </CommandPanel>

        {/* 外灰槽底栏：coss CommandFooter + Kbd 键位提示 */}
        <CommandFooter className="border-t-0 bg-transparent px-3 py-2 text-[11px]">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="inline-flex items-center gap-1">
              <Kbd>↑↓</Kbd> 选择
            </span>
            <span className="inline-flex items-center gap-1">
              <Kbd>Enter</Kbd> 打开
            </span>
            <span className="inline-flex items-center gap-1">
              <Kbd>⇧Enter</Kbd> 时光机
            </span>
            <span className="inline-flex items-center gap-1">
              <Kbd>Ctrl+Enter</Kbd> 定位目录
            </span>
            <span className="inline-flex items-center gap-1">
              <Kbd>Tab</Kbd> Tab 加入证据篮
            </span>
            <span className="inline-flex items-center gap-1">
              <Kbd>Esc</Kbd> 关闭
            </span>
          </div>
          {searching ? (
            <span className="ml-auto animate-pulse" data-command-palette-searching="true">
              检索中…
            </span>
          ) : null}
        </CommandFooter>
      </div>
    </div>
  );
}
