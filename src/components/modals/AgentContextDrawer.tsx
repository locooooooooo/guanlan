import React, { useEffect, useRef, useState } from "react";
import {
  Check,
  ClipboardCopy,
  Trash2,
  X,
} from "lucide-react";
import {
  EvidencePointer,
} from "../../types/guanlan";
import {
  fetchRevisionContentsBatch,
  fetchWorkspaceStatus,
  getActiveLoopbackEndpoint,
  postContext,
  postMcpHostConfig,
} from "../../services/workspaceClient";
import type {
  ContextGranularity,
  ContextResponse,
  McpHostTarget,
} from "../../services/apiTypes";
import { copyTextWithDesktopFallback } from "../../services/desktopBridge";
import { basenameOf } from "../../utils/documentIdentity";
import { cleanDisplayText } from "../../utils/displayText";
import { taskPackageOf } from "../../utils/taskPackages";
import type { ZhendaogeIntent } from "../../utils/zhendaogePresets";
import {
  buildGuanlanContextMarkdown,
  buildHostMcpJsonConfig,
  buildMcpJsonConfig,
  buildMcpPayload,
  MCP_HOST_TARGETS,
  type GuanlanContextBlockerLine,
  type GuanlanContextDecisionLine,
} from "../../utils/zhendaogeExport";
import {
  computeTokenBudget,
  estimateItemChars,
  estimateItemTokens,
  formatBudgetLine,
} from "../../utils/contextBudget";
import DecisionChangeNoteCard from "../DecisionChangeNoteCard";
import type { DecisionChangeNote } from "../../utils/decisionChangeNote";
import { Button, Chip, IconButton } from "../ui/primitives";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  ScrollArea,
} from "../ui";

/* ============================================================================
 * 3. 证据篮抽屉（P1-6 定名：题改「给智能体的上下文清单」，全库不再中英并存，§2.2, §10）
 * ==========================================================================*/
/** 契约②卡片首行「来源视图」徽：evidence_kind → 展示文案 */
const EVIDENCE_KIND_LABEL: Record<EvidencePointer['evidence_kind'], string> = {
  explicit_source: '阅读器/画布',
  decision_record: '决策卡',
  svg_label: 'SVG 文字层',
  metadata_only: '检视器',
};

/** 契约②卡片第二行「类型」：locator.kind → 展示文案 */
const formatLocatorLabel = (locator: EvidencePointer['locator']): string => {
  switch (locator.kind) {
    case 'lines':
      return `行段 L${locator.start}–L${locator.end}`;
    case 'pdf_page':
      return `PDF 第 ${locator.page} 页`;
    case 'svg_text':
      return `SVG 文字「${locator.fragment}」`;
    case 'file':
    default:
      return '整文件';
  }
};

export interface AgentContextDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  pointers: EvidencePointer[];
  onRemovePointer: (index: number) => void;
  onClearPointers: () => void;
  workspaceRoot: string;
  /** E03：当前焦点文件 id（传入 POST /api/v1/context 以便服务端同源组装与抽取上游规范片段） */
  focusFileId?: string | null;
  // ── 证道阁改造（PRD 4.1–4.3 / 方案 F4）─────────────────────────────────
  /** AC-05：当前专项（模式 A 根标签 initiative/stage、模式 B initiative 对象）；
   *  首页总览入口无专项焦点时为 null（如实省略/置 null，不造专项）。 */
  initiative?: { id: string; name: string; stage: string } | null;
  /** AC-05：本次会话/专项最新成功 Checkpoint（模式 B session_checkpoint_id）；
   *  无专项、无 checkpoint 或查询失败时为 null。 */
  sessionCheckpointId?: string | null;
  /** AC-05：引用行版本/状态标签（App 由 files + /state-overview 提供）；
   *  返回 null 的字段如实省略，不造版本/状态。 */
  referenceMetaOf?: (pointer: EvidencePointer) => {
    versionLabel?: string | null;
    stateLabel?: string | null;
  };
  /** 路由意图（App 推导：文档正文页 document / 专项详情 initiative / 首页总览 global） */
  intent: ZhendaogeIntent;
  /** 预置任务意图模板（PRD 4.1 第三列） */
  intentTemplate: string;
  /** 默认包（AC-04 消除「0项已选」）：App 由 buildZhendaogePreset 组装的入篮条目 */
  presetPointers: EvidencePointer[];
  /** 推荐挂载（基于星图血缘与代码引用）：App 预转的入篮条目 + reason 徽标 */
  recommendedMounts: Array<{ pointer: EvidencePointer; reason: string }>;
  /** 带入清单（追加去重归 App） */
  onMountPointers: (items: EvidencePointer[]) => void;
  /** 单条注入粒度切换（E03 四档 + 兼容 decisions_only） */
  onUpdatePointerGranularity: (
    index: number,
    granularity: ContextGranularity
  ) => void;
  /** 模式 A 决策段数据（App 由 decisions 过滤出的已确认/未决行） */
  confirmedDecisions: GuanlanContextDecisionLine[];
  pendingBlockers: GuanlanContextBlockerLine[];
  /** AC-03：App 主动推送到证道阁的《最新已拍板决策变更单》；null=暂无 */
  decisionChangeNote?: DecisionChangeNote | null;
  /** E03：测试/首屏预注服务端同源 ContextResponse（使预览区/复制/MCP 逐字节一致可单测锁定） */
  initialServerContext?: ContextResponse | null;
}

const GRANULARITY_CHIPS: ReadonlyArray<{
  key: ContextGranularity;
  label: string;
}> = [
  { key: 'full', label: '全文' },
  { key: 'summary', label: '仅大纲与结论' },
  { key: 'diff_only', label: '仅变更 Diff' },
  { key: 'metadata_only', label: '仅元数据路径' },
];

const granularityLabelOf = (p: EvidencePointer): string => {
  const g = p.granularity ?? 'full';
  if (g === 'decisions_only') return '仅决策与契约';
  return GRANULARITY_CHIPS.find((c) => c.key === g)?.label ?? '全文';
};

/** 证据篮去重键（与 App.handleMountPointers 同口径；用于统计默认包已挂载数） */
const pointerKeyOf = (p: EvidencePointer): string =>
  `${p.file_id}::${p.revision_id}::${p.locator.kind}`;

export const AgentContextDrawer: React.FC<AgentContextDrawerProps> = ({
  isOpen,
  onClose,
  pointers,
  onRemovePointer,
  onClearPointers,
  workspaceRoot,
  focusFileId,
  initiative,
  sessionCheckpointId,
  referenceMetaOf,
  intent,
  intentTemplate,
  presetPointers,
  recommendedMounts,
  onMountPointers,
  onUpdatePointerGranularity,
  confirmedDecisions,
  pendingBlockers,
  decisionChangeNote,
  initialServerContext = null,
}) => {
  const [copied, setCopied] = useState(false);
  const [promptCopied, setPromptCopied] = useState(false);
  const [mcpJsonCopied, setMcpJsonCopied] = useState(false);
  const [viewFormat, setViewFormat] = useState<'markdown' | 'json'>('markdown');
  // E03：主流宿主一键配置（ZCode / Claude Code / Cursor）
  const [selectedHost, setSelectedHost] = useState<McpHostTarget>('zcode');
  const [hostConfigBusy, setHostConfigBusy] = useState(false);
  const [hostConfigNotice, setHostConfigNotice] = useState<{
    ok: boolean;
    message: string;
  } | null>(null);
  // E03：服务端同源组装结果（保证预览区、一键复制与 MCP get_context_bundle 逐字节一致）
  const [serverContext, setServerContext] = useState<ContextResponse | null>(
    initialServerContext
  );
  const [serverSyncing, setServerSyncing] = useState(false);
  // MCP 连接自检（F4 ⑤）：抽屉打开时探测本地服务（GET /api/v1/status 轻端点）。
  // 可达 → 绿灯；不可达/网络层失败 → 琥珀提示（阅读/批注可用，MCP 回写待服务启动）
  const [mcpStatus, setMcpStatus] = useState<'checking' | 'ok' | 'down'>('checking');

  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    setMcpStatus('checking');
    void (async () => {
      const status = await fetchWorkspaceStatus();
      if (!cancelled) setMcpStatus(status.ok ? 'ok' : 'down');
    })();
    return () => {
      cancelled = true;
    };
  }, [isOpen]);

  // E03：构造请求指纹并同步拉取服务端 POST /api/v1/context（单一真相源）
  const serverRequestKey = JSON.stringify({
    intent,
    focusFileId: focusFileId ?? null,
    initiativeId: initiative?.id ?? null,
    items: pointers.map((p) => ({
      file_id: p.file_id,
      revision_id: p.revision_id || undefined,
      granularity: p.granularity ?? 'full',
    })),
  });

  useEffect(() => {
    if (!isOpen) return;
    if (initialServerContext) {
      setServerContext(initialServerContext);
      return;
    }
    let cancelled = false;
    setServerSyncing(true);
    const timer = setTimeout(() => {
      void (async () => {
        const res = await postContext({
          intent,
          focus_file_id: focusFileId || undefined,
          initiative_id: initiative?.id || undefined,
          items: pointers.map((p) => ({
            file_id: p.file_id,
            revision_id: p.revision_id || undefined,
            granularity: (p.granularity ?? 'full') as ContextGranularity,
          })),
          mode: 'both',
        });
        if (cancelled) return;
        setServerSyncing(false);
        if (res.ok) {
          setServerContext(res.data);
        } else {
          setServerContext(null);
        }
      })();
    }, 60);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [isOpen, serverRequestKey, initialServerContext]);

  // AC-04：默认包自动勾选的兜底通道——App 打开抽屉前已预挂载（首帧即 N 项）；
  // 若打开时数据尚未就绪（presetPointers 为空）或未来有新入口绕过 openContextDrawer，
  // 数据到达后自动补挂。每个打开周期只补一次：用户手动移除条目后不会被 effect 反复补回。
  const autoMountedRef = useRef(false);
  useEffect(() => {
    if (!isOpen) {
      autoMountedRef.current = false;
      return;
    }
    if (autoMountedRef.current) return;
    if (presetPointers.length === 0) return;
    autoMountedRef.current = true;
    onMountPointers(presetPointers);
  }, [isOpen, presetPointers, onMountPointers]);

  if (!isOpen) return null;

  const effectiveServerContext = initialServerContext ?? serverContext;
  const serverItemById = new Map(
    (effectiveServerContext?.preset.items ?? []).map((it) => [it.file_id, it])
  );
  const upstreamSnippets = effectiveServerContext?.upstream_snippets ?? [];
  const redactedSecretsCount = effectiveServerContext?.redacted_secrets_count ?? 0;

  // AC-04：默认包已挂载数（App 在打开抽屉前自动挂载；此处仅用于展示状态/补齐按钮）。
  // 用去重键比较，避免同一文件不同粒度被误判为未挂载。
  const mountedPresetCount = presetPointers.filter((p) => {
    const key = pointerKeyOf(p);
    return pointers.some((q) => pointerKeyOf(q) === key);
  }).length;

  // 每条条目注入粒度（PRD 4.2 + E03；EvidencePointer.granularity 缺省 full）
  const granularityOf = (p: EvidencePointer): ContextGranularity => p.granularity ?? 'full';

  // Token + 字符预算（在线优先采信服务端实算结果，离线按双端同源公式估算）
  const localBudgetView = computeTokenBudget(
    pointers.map((p) => ({
      fileId: p.file_id,
      granularity: granularityOf(p),
      sizeBytes: p.sizeBytes ?? null,
    }))
  );
  const budgetView = effectiveServerContext
    ? {
        selected: effectiveServerContext.token_budget.selected,
        estChars: effectiveServerContext.token_budget.est_chars ?? localBudgetView.estChars ?? 0,
        estTokens: effectiveServerContext.token_budget.est_tokens,
        threshold: effectiveServerContext.token_budget.threshold,
        overThreshold: effectiveServerContext.token_budget.over_threshold,
        downgradeSuggestions: effectiveServerContext.token_budget.downgrade_suggestions,
      }
    : localBudgetView;

  // 双模导出（PRD 4.3 + E03）：离线降级走 zhendaogeExport，在线优先采用服务端
  // POST /api/v1/context 响应（与 MCP guanlan.get_context_bundle 逐字节同源一致）
  const granularityLabelForOffline = (
    g: ContextGranularity
  ): '全文' | '摘要' | '引用' | '仅大纲与结论' | '仅变更 Diff' | '仅元数据路径' => {
    if (g === 'full') return '全文';
    if (g === 'summary') return '摘要';
    if (g === 'diff_only') return '仅变更 Diff';
    if (g === 'metadata_only') return '仅元数据路径';
    return '引用';
  };
  const offlineMarkdown = buildGuanlanContextMarkdown({
    workspaceRoot,
    initiative: initiative ? { name: initiative.name, stage: initiative.stage } : null,
    confirmedDecisions,
    pendingBlockers,
    referenceFiles: pointers.map((p) => {
      const meta = referenceMetaOf?.(p);
      return {
        path: p.relative_path,
        granularityLabel: granularityLabelForOffline(granularityOf(p)),
        versionLabel: meta?.versionLabel ?? null,
        stateLabel: meta?.stateLabel ?? null,
      };
    }),
  });
  const offlineMcpPayload = buildMcpPayload({
    workspaceRoot,
    initiative: initiative ?? null,
    sessionCheckpointId: sessionCheckpointId ?? null,
    contextBundle: pointers.map((p) => {
      const meta = referenceMetaOf?.(p);
      return {
        path: p.relative_path,
        granularity: granularityOf(p),
        versionLabel: meta?.versionLabel ?? null,
        contentHash: p.content_sha256 || null,
      };
    }),
  });
  const modeAMarkdown = effectiveServerContext?.markdown ?? offlineMarkdown;
  const mcpPayload = effectiveServerContext?.payload ?? offlineMcpPayload;
  const isServerAuthoritative = Boolean(
    effectiveServerContext &&
      (viewFormat === 'markdown'
        ? effectiveServerContext.markdown !== null
        : effectiveServerContext.payload !== null)
  );
  const unifiedExportText =
    viewFormat === 'markdown' ? modeAMarkdown : JSON.stringify(mcpPayload, null, 2);

  const formattedText = unifiedExportText;

  const copyWithFeedback = async (
    text: string,
    setFlag: React.Dispatch<React.SetStateAction<boolean>>
  ) => {
    const res = await copyTextWithDesktopFallback(text);
    if (res.ok) {
      setFlag(true);
      setTimeout(() => setFlag(false), 2000);
    } else {
      // C4：复制失败不再谎报成功——重置为 false
      setFlag(false);
    }
  };

  const activeLoopbackEndpoint = getActiveLoopbackEndpoint();
  const selectedHostMeta =
    MCP_HOST_TARGETS.find((h) => h.id === selectedHost) ?? MCP_HOST_TARGETS[0];

  const handleCopy = () => void copyWithFeedback(unifiedExportText, setCopied);
  const handleGeneratePrompt = () => void copyWithFeedback(unifiedExportText, setPromptCopied);
  const handleCopyMcpJson = () => {
    const configText =
      selectedHost === 'zcode' && activeLoopbackEndpoint === 'http://127.0.0.1:39120'
        ? buildMcpJsonConfig(activeLoopbackEndpoint)
        : buildHostMcpJsonConfig(selectedHost, activeLoopbackEndpoint);
    void copyWithFeedback(configText, setMcpJsonCopied);
  };
  const handleWriteHostMcpConfig = async () => {
    setHostConfigBusy(true);
    setHostConfigNotice(null);
    const res = await postMcpHostConfig({
      host: selectedHost,
      endpoint: activeLoopbackEndpoint,
      dry_run: false,
      confirm: true,
    });
    setHostConfigBusy(false);
    if (res.ok) {
      setHostConfigNotice({
        ok: true,
        message: `${selectedHostMeta.label} 已${res.data.merged_existing ? '无损合并更新' : '写入'} ${res.data.target_relative_path}（端点 ${res.data.endpoint}）`,
      });
    } else {
      setHostConfigNotice({
        ok: false,
        message: res.error || '本地服务未就绪，请先点击左侧复制按钮手动粘贴配置',
      });
    }
  };

  const chipClassFor = (key: ContextGranularity, current: ContextGranularity) =>
    `cursor-pointer rounded-full border px-1.5 py-px text-[length:var(--text-micro)] leading-[var(--lh-micro)] transition-colors ${
      key === current
        ? 'border-[color:var(--stage-ink-decision)] text-[color:var(--stage-ink-decision-text)] bg-[color:color-mix(in_srgb,var(--stage-ink-decision)_10%,transparent)]'
        : 'border-[color:var(--glass-hairline)] text-[color:var(--ink-soft)] hover:text-[color:var(--ink-strong)]'
    }`;

  const tokenRatio = Math.min(
    100,
    Math.max(0, Math.round((budgetView.estTokens / Math.max(1, budgetView.threshold)) * 100))
  );

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="复制给智能体的上下文清单"
      data-esc-layer="open"
      className="glx-backdrop-in fixed inset-0 z-50 bg-[color:var(--ink-anchor)]/38 dark:bg-black/62 backdrop-blur-sm flex justify-end p-2 sm:p-3"
    >
      {/* V08：coss Sheet (variant="inset") 悬浮抽屉材质，明暗双态自适应 */}
      <div
        data-sheet-variant="inset"
        className="glx-drawer-in bg-popover/95 dark:bg-popover/95 backdrop-blur-2xl w-full max-w-xl h-full flex flex-col overflow-hidden rounded-2xl border border-border/85 text-foreground"
        style={{ boxShadow: 'var(--glass-shadow-pop)' }}
      >
        <div className="px-6 py-4 bg-card/85 backdrop-blur-md border-b border-border/80 flex items-center justify-between">
          <div>
            <h2 className="font-serif-claude text-[17px] leading-[1.35] font-semibold tracking-[-0.01em] text-foreground">
              证据篮 · 给智能体的上下文清单
            </h2>
            <p className="text-[length:var(--text-ui)] leading-[var(--lh-ui)] text-muted-foreground mt-0.5">
              按当前路由自动组装上下文包，复制或经 MCP 直连回写。
            </p>
          </div>
          <IconButton label="关闭上下文抽屉" onClick={onClose} className="cursor-pointer">
            <X />
          </IconButton>
        </div>

        <ScrollArea scrollFade className="flex-1 min-h-0">
        <div className="p-6 space-y-4">
          {/* AC-03：App 主动推送的最新已拍板决策变更单（置顶，先于默认包/清单） */}
          {decisionChangeNote && <DecisionChangeNoteCard note={decisionChangeNote} />}

          {/* MCP 连接自检 + E03 本机主流宿主 .mcp.json 零冷启动配置（ZCode / Claude Code / Cursor） */}
          <div className="rounded-[var(--r-block)] border border-border/80 bg-card/75 px-3 py-2.5 space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="flex items-center gap-1.5 text-[length:var(--text-ui)] leading-[var(--lh-ui)]">
                <span
                  aria-hidden="true"
                  className={`w-1.5 h-1.5 rounded-full ${
                    mcpStatus === 'ok'
                      ? 'bg-[color:var(--stage-ink-deliver)]'
                      : mcpStatus === 'checking'
                        ? 'bg-[color:var(--ink-soft)] animate-pulse'
                        : 'bg-[color:var(--stage-ink-decision)]'
                  }`}
                />
                {mcpStatus === 'ok' ? (
                  <span className="text-[color:var(--stage-ink-deliver-text)]">本地服务已就绪</span>
                ) : mcpStatus === 'checking' ? (
                  <span className="text-[color:var(--ink-soft)]">正在探测本地服务…</span>
                ) : (
                  <span className="text-[color:var(--stage-ink-decision-text)]">
                    本地服务未就绪——复制/阅读照常，MCP 回写待启动
                  </span>
                )}
              </span>
              <div className="flex flex-wrap items-center gap-1.5">
                <Button variant="secondary" size="sm" onClick={handleCopyMcpJson} className="cursor-pointer">
                  {mcpJsonCopied ? (
                    <>
                      <Check className="w-3.5 h-3.5" />
                      <span>mcp.json 已复制</span>
                    </>
                  ) : (
                    <>
                      <ClipboardCopy className="w-3.5 h-3.5" />
                      <span>一键复制 mcp.json 配置</span>
                    </>
                  )}
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={hostConfigBusy}
                  onClick={() => void handleWriteHostMcpConfig()}
                  data-mcp-host-write={selectedHost}
                  className="cursor-pointer"
                  title={`无损合并写入 ${selectedHostMeta.targetPath}（仅含本地回环 GUANLAN_ENDPOINT，绝不写入本机密钥）`}
                >
                  <span>
                    {hostConfigBusy
                      ? '配置中…'
                      : `自动配置 ${selectedHostMeta.label}`}
                  </span>
                </Button>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-1.5 pt-0.5" data-mcp-host-selector="">
              <span className="text-[length:var(--text-micro)] leading-[var(--lh-micro)] text-[color:var(--ink-soft)]">
                目标宿主
              </span>
              {MCP_HOST_TARGETS.map((host) => (
                <button
                  key={host.id}
                  type="button"
                  aria-pressed={selectedHost === host.id}
                  data-mcp-host-option={host.id}
                  onClick={() => {
                    setSelectedHost(host.id);
                    setHostConfigNotice(null);
                  }}
                  className={`cursor-pointer rounded-full border px-2 py-px text-[length:var(--text-micro)] leading-[var(--lh-micro)] transition-colors ${
                    selectedHost === host.id
                      ? 'border-[color:var(--accent-iris)] text-[color:var(--accent-iris-deep)] bg-[color:color-mix(in_srgb,var(--accent-iris)_10%,transparent)]'
                      : 'border-[color:var(--glass-hairline)] text-[color:var(--ink-soft)] hover:text-[color:var(--ink-strong)]'
                  }`}
                  title={host.description}
                >
                  {host.label} ({host.targetPath})
                </button>
              ))}
            </div>
            {hostConfigNotice && (
              <div
                data-mcp-host-notice=""
                className={`text-[length:var(--text-micro)] leading-[var(--lh-micro)] rounded-[8px] px-2.5 py-1.5 ${
                  hostConfigNotice.ok
                    ? 'bg-[color:color-mix(in_srgb,var(--stage-ink-deliver)_10%,transparent)] text-[color:var(--stage-ink-deliver-text)]'
                    : 'bg-[color:color-mix(in_srgb,var(--stage-ink-decision)_10%,transparent)] text-[color:var(--stage-ink-decision-text)]'
                }`}
              >
                {hostConfigNotice.message}
              </div>
            )}
          </div>

          {redactedSecretsCount > 0 && (
            <div
              data-context-redacted-notice=""
              className="rounded-[var(--r-block)] border border-[color:color-mix(in_srgb,var(--stage-ink-deliver)_32%,transparent)] bg-[color:color-mix(in_srgb,var(--stage-ink-deliver)_8%,white)] px-3 py-2 text-[length:var(--text-micro)] leading-[var(--lh-micro)] text-[color:var(--stage-ink-deliver-text)]"
            >
              安全脱敏护栏已拦截并隐藏 {redactedSecretsCount} 处疑似密钥/敏感凭证（替换为 [REDACTED_SECRET]），未混入任何本机环境变量。
            </div>
          )}

          {/* 路由意图 + 默认包（PRD 4.1 / AC-04）：消除「一键复制上下文清单 (0项已选)」空态——
              预填条目一键带入，意图模板随路由预置 */}
          <div className="rounded-[var(--r-block)] border border-[color:var(--glass-hairline)] bg-white/60 px-3 py-2.5 space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[length:var(--text-micro)] leading-[var(--lh-micro)] font-medium px-1.5 py-0.5 rounded-[var(--r-pill)] bg-[color:color-mix(in_srgb,var(--accent-iris)_10%,transparent)] text-[color:var(--accent-iris-ink)]">
                {intent === 'document' ? '文档正文页' : intent === 'initiative' ? '专项详情' : '首页总览'}
              </span>
              <span className="text-[length:var(--text-ui)] leading-[var(--lh-ui)] text-[color:var(--ink-soft)] truncate">
                {intentTemplate}
              </span>
            </div>
            {presetPointers.length > 0 &&
              (mountedPresetCount === presetPointers.length ? (
                /* AC-04：默认包已自动勾选（App 打开抽屉前挂载）——展示状态而非再要求点击 */
                <p
                  data-preset-auto-mounted=""
                  className="flex items-center gap-1.5 text-[length:var(--text-ui)] leading-[var(--lh-ui)] text-[color:var(--stage-ink-deliver-text)]"
                >
                  <Check className="w-3.5 h-3.5 shrink-0" />
                  <span>默认上下文已自动带入（{presetPointers.length} 项已选）</span>
                </p>
              ) : (
                <Button
                  variant={mountedPresetCount === 0 ? 'primary' : 'secondary'}
                  size="sm"
                  fullWidth
                  onClick={() => onMountPointers(presetPointers)}
                  className="cursor-pointer"
                >
                  <Check className="w-3.5 h-3.5" />
                  <span>
                    {mountedPresetCount === 0
                      ? `带入默认上下文 (${presetPointers.length} 项已选)`
                      : `补齐默认上下文 (${presetPointers.length - mountedPresetCount} 项)`}
                  </span>
                </Button>
              ))}
          </div>

          <div className="flex items-center justify-between gap-2 text-xs">
            {/* 双模导出分段轨（PRD 4.3）：模式 A=Markdown 提示词清单 / 模式 B=MCP 载荷 (JSON) */}
            <div className="inline-flex items-center gap-1 rounded-[10px] bg-[color:var(--depth-1-bg)] p-0.5">
              <Chip
                active={viewFormat === 'markdown'}
                onClick={() => setViewFormat('markdown')}
                className="cursor-pointer"
              >
                Markdown 提示词清单
              </Chip>
              <Chip
                active={viewFormat === 'json'}
                onClick={() => setViewFormat('json')}
                className="cursor-pointer"
              >
                MCP 载荷 (JSON)
              </Chip>
            </div>

            {/* 破坏性动作归 danger 描边式（§4.1 变体表） */}
            {pointers.length > 0 && (
              <Button
                variant="danger"
                size="sm"
                onClick={onClearPointers}
                className="cursor-pointer"
              >
                <Trash2 className="w-3.5 h-3.5" />
                <span>清空清单</span>
              </Button>
            )}
          </div>

          {/* Selected Evidence Cards（证据篮条目卡 + 注入粒度 chips；空态走 coss Empty 三卡扇形） */}
          <div className="space-y-2.5">
            {pointers.length === 0 && (
              <Empty className="rounded-2xl border border-dashed border-border/80 bg-card/65 py-6">
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <ClipboardCopy className="size-4" />
                  </EmptyMedia>
                  <EmptyTitle>证据篮暂未装入条目</EmptyTitle>
                  <EmptyDescription>
                    可在阅读器、Ctrl+K 检索或轻预览中按 Tab 一键收集文档与决策引用，或点上方按钮带入当前路由默认上下文
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            )}
            {pointers.map((p, idx) => (
              <div
                key={`${p.file_id}-${p.revision_id}-${idx}`}
                className="depth-2-card depth-2-card-hover p-3.5 space-y-1.5"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1 space-y-1.5">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <span className="text-[length:var(--text-micro)] leading-[var(--lh-micro)] font-medium px-2 py-0.5 rounded-[var(--r-pill)] bg-[color:color-mix(in_srgb,var(--accent-iris)_10%,transparent)] text-[color:var(--accent-iris-ink)] shrink-0">
                        {EVIDENCE_KIND_LABEL[p.evidence_kind]}
                      </span>
                      <span
                        className="shrink-0 rounded-[var(--r-ctl)] bg-[color:var(--depth-1-bg)] px-1.5 py-0.5 text-[length:var(--text-micro)] leading-[var(--lh-micro)] font-medium text-[color:var(--ink-soft)]"
                        title={`任务包：${taskPackageOf(p.relative_path).name}`}
                      >
                        {taskPackageOf(p.relative_path).name}
                      </span>
                      <span
                        className="font-mono text-[color:var(--accent-iris-deep)] text-[length:var(--text-ui)] leading-[var(--lh-ui)] font-medium truncate"
                        title={p.relative_path}
                      >
                        {basenameOf(p.relative_path)}
                      </span>
                    </div>
                    <div className="text-[length:var(--text-micro)] leading-[var(--lh-micro)] text-[color:var(--ink-soft)] tabular-nums">
                      {formatLocatorLabel(p.locator)}
                    </div>
                    <p className="text-[length:var(--text-ui)] leading-[var(--lh-ui)] text-[color:var(--ink-soft)] line-clamp-2">
                      {cleanDisplayText(p.excerpt) || p.excerpt}
                    </p>
                    {/* 注入粒度 chips（E03 四档）：全文 / 仅大纲与结论 / 仅变更 Diff / 仅元数据路径 */}
                    <div className="flex flex-wrap items-center gap-1 pt-0.5">
                      <span className="text-[length:var(--text-micro)] leading-[var(--lh-micro)] text-[color:var(--ink-soft)] mr-0.5">
                        注入粒度
                      </span>
                      {GRANULARITY_CHIPS.map((chip) => (
                        <button
                          key={chip.key}
                          type="button"
                          aria-pressed={granularityOf(p) === chip.key}
                          data-context-granularity={`${idx}:${chip.key}`}
                          onClick={() => onUpdatePointerGranularity(idx, chip.key)}
                          className={chipClassFor(chip.key, granularityOf(p))}
                        >
                          {chip.label}
                        </button>
                      ))}
                      {granularityOf(p) === 'decisions_only' && (
                        <button
                          type="button"
                          aria-pressed={true}
                          data-context-granularity={`${idx}:decisions_only`}
                          onClick={() => onUpdatePointerGranularity(idx, 'decisions_only')}
                          className={chipClassFor('decisions_only', granularityOf(p))}
                        >
                          {granularityLabelOf(p)}
                        </button>
                      )}
                      {(() => {
                        const serverItem = serverItemById.get(p.file_id);
                        const itemTokens = serverItem
                          ? serverItem.est_tokens
                          : Math.ceil(
                              estimateItemTokens({
                                fileId: p.file_id,
                                granularity: granularityOf(p),
                                sizeBytes: p.sizeBytes ?? null,
                              })
                            );
                        const itemChars = serverItem?.est_chars ?? estimateItemChars({
                          fileId: p.file_id,
                          granularity: granularityOf(p),
                          sizeBytes: p.sizeBytes ?? null,
                        });
                        return (
                          <span
                            className="ml-1 text-[length:var(--text-micro)] leading-[var(--lh-micro)] font-mono text-[color:var(--ink-soft)] tabular-nums"
                            title={
                              serverItem
                                ? '服务端按真实快照实算'
                                : p.sizeBytes
                                  ? '按当前版体量上界估算'
                                  : '体量未知（按 0 估算）'
                            }
                          >
                            约 {itemChars} 字 · {itemTokens} tok
                          </span>
                        );
                      })()}
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0 pt-0.5">
                    <span className="font-mono text-[length:var(--text-micro)] leading-[var(--lh-micro)] tabular-nums text-[color:var(--ink-soft)]">[{idx + 1}]</span>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => onRemovePointer(idx)}
                      aria-label={`移除第 ${idx + 1} 条证据`}
                      className="cursor-pointer"
                    >
                      <X className="w-3.5 h-3.5" />
                    </Button>
                  </div>
                </div>
              </div>
            ))}
          </div>

          {/* Token 预算条（PRD 4.2）：已选 N 项 · 约 Xk Tokens (推荐阈值 < 64k) + 可视化预算水位条 */}
          <div
            className={`space-y-2 rounded-[12px] border px-3.5 py-2.5 text-[length:var(--text-ui)] leading-[var(--lh-ui)] tabular-nums ${
              budgetView.overThreshold
                ? 'border-[color:var(--stage-ink-decision)] bg-[color:color-mix(in_srgb,var(--stage-ink-decision)_10%,transparent)] text-[color:var(--stage-ink-decision-text)]'
                : 'border-[color:var(--glass-hairline)] bg-white/75 text-[color:var(--ink-soft)]'
            }`}
            data-context-budget-bar=""
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-medium text-[color:var(--ink-strong)]">
                {formatBudgetLine(budgetView)}
              </span>
              <span className="font-mono text-[length:var(--text-micro)] leading-[var(--lh-micro)] text-[color:var(--ink-soft)]">
                约 {(budgetView.estChars ?? 0).toLocaleString()} 字符
              </span>
            </div>
            {budgetView.overThreshold && (
              <div className="text-[length:var(--text-micro)] leading-[var(--lh-micro)]">
                超出推荐阈值，建议降级：
                {budgetView.downgradeSuggestions.length === 0 ? (
                  <span>无可降级条目</span>
                ) : (
                  budgetView.downgradeSuggestions.map((fileId) => {
                    const idx = pointers.findIndex((p) => p.file_id === fileId);
                    if (idx < 0) return null;
                    return (
                      <button
                        key={fileId}
                        type="button"
                        data-context-downgrade={fileId}
                        onClick={() => onUpdatePointerGranularity(idx, 'summary')}
                        className="mx-1 underline underline-offset-2 cursor-pointer"
                        title="将该文档注入粒度降为仅大纲与结论"
                      >
                        {basenameOf(pointers[idx].relative_path)} → 仅大纲与结论
                      </button>
                    );
                  })
                )}
              </div>
            )}
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-[color:var(--depth-1-bg)]">
              <div
                className="h-full rounded-full transition-all duration-300"
                style={{
                  width: `${Math.max(tokenRatio, budgetView.estTokens > 0 ? 4 : 0)}%`,
                  background: budgetView.overThreshold
                    ? 'var(--stage-ink-decision)'
                    : 'linear-gradient(90deg, var(--accent-iris) 0%, var(--stage-ink-deliver) 100%)',
                }}
              />
            </div>
          </div>

          {/* 推荐挂载（PRD 4.1「基于星图血缘与代码引用」折叠栏）：reason 徽标 + 一键挂载 */}
          {recommendedMounts.length > 0 && (
            <details className="rounded-[var(--r-block)] border border-[color:var(--glass-hairline)] bg-white/60 px-3 py-2">
              <summary className="cursor-pointer text-[length:var(--text-ui)] leading-[var(--lh-ui)] font-medium text-[color:var(--ink-soft)]">
                推荐挂载（基于星图血缘与代码引用） · {recommendedMounts.length}
              </summary>
              <div className="mt-2 space-y-1.5">
                {recommendedMounts.map(({ pointer, reason }) => (
                  <div
                    key={`rec-${pointer.file_id}`}
                    className="flex items-center justify-between gap-2 rounded-[var(--r-ctl)] border border-[color:var(--glass-hairline)] bg-white/55 px-2.5 py-1.5"
                  >
                    <span className="flex items-center gap-1.5 min-w-0">
                      <span
                        className="shrink-0 rounded-[var(--r-pill)] px-1.5 py-px text-[length:var(--text-micro)] leading-[var(--lh-micro)] bg-[color:color-mix(in_srgb,var(--accent-iris)_10%,transparent)] text-[color:var(--accent-iris-ink)]"
                        title={`推荐依据：${reason}`}
                      >
                        {reason}
                      </span>
                      <span className="font-mono text-[length:var(--text-ui)] leading-[var(--lh-ui)] text-[color:var(--ink-strong)] truncate" title={pointer.relative_path}>
                        {basenameOf(pointer.relative_path)}
                      </span>
                    </span>
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => onMountPointers([pointer])}
                      className="cursor-pointer shrink-0"
                    >
                      一键挂载
                    </Button>
                  </div>
                ))}
              </div>
            </details>
          )}

          {/* E03：上游规范引用片段（服务端按星图引用边自动抽取并脱敏） */}
          {upstreamSnippets.length > 0 && (
            <details
              open
              data-context-upstream-snippets=""
              className="rounded-[var(--r-block)] border border-[color:var(--glass-hairline)] bg-white/60 px-3 py-2"
            >
              <summary className="cursor-pointer text-[length:var(--text-ui)] leading-[var(--lh-ui)] font-medium text-[color:var(--ink-strong)]">
                上游规范引用片段（已自动随包带入） · {upstreamSnippets.length}
              </summary>
              <div className="mt-2 space-y-2">
                {upstreamSnippets.map((up) => (
                  <div
                    key={`up-${up.file_id}`}
                    className="rounded-[var(--r-ctl)] border border-[color:var(--glass-hairline)] bg-white/65 px-2.5 py-2 space-y-1"
                  >
                    <div className="flex items-center justify-between gap-2 text-[length:var(--text-micro)] leading-[var(--lh-micro)]">
                      <span className="font-mono font-medium text-[color:var(--accent-iris-deep)] truncate" title={up.path}>
                        {up.path}
                        {up.version_label ? ` (${up.version_label})` : ''}
                      </span>
                      <span className="shrink-0 font-mono text-[color:var(--ink-soft)] tabular-nums">
                        {up.est_chars} 字 · {up.est_tokens} tok
                      </span>
                    </div>
                    <pre className="text-[11px] leading-[1.45] font-mono text-[color:var(--ink-soft)] whitespace-pre-wrap break-all max-h-24 overflow-y-auto">
                      {up.snippet}
                    </pre>
                  </div>
                ))}
              </div>
            </details>
          )}

          {/* Formatted Output Preview（双模预览；在线与 MCP get_context_bundle 逐字节同源） */}
          <div className="space-y-1.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-[length:var(--text-ui)] leading-[var(--lh-ui)] font-semibold text-[color:var(--ink-soft)]">
                复制下方文本，粘贴给你使用的智能体（ZCode / Claude Code / Cursor）：
              </span>
              <span className="flex items-center gap-1.5 font-mono text-[10.5px] text-[color:var(--ink-faint)] tabular-nums shrink-0">
                <span
                  data-context-source-parity={isServerAuthoritative ? 'server' : 'offline'}
                  className={
                    isServerAuthoritative
                      ? 'text-[color:var(--stage-ink-deliver-text)]'
                      : 'text-[color:var(--ink-soft)]'
                  }
                >
                  {serverSyncing
                    ? '同步中…'
                    : isServerAuthoritative
                      ? '服务端同源（与 MCP get_context_bundle 逐字节一致）'
                      : '离线降级预览'}
                </span>
                <span>·</span>
                <span>
                  {viewFormat === 'json' ? 'JSON' : 'MARKDOWN'} · {formattedText.length} 字符
                </span>
              </span>
            </div>
            <pre
              data-context-export-preview=""
              className="p-3.5 rounded-[12px] border border-[color:var(--glass-hairline)] bg-[color:var(--depth-1-bg-soft)] text-[11.5px] leading-[1.55] font-mono text-[color:var(--ink-strong)] whitespace-pre-wrap break-all max-h-64 overflow-y-auto shadow-[inset_0_1px_3px_rgba(38,36,61,0.04)]"
            >
              {formattedText}
            </pre>
          </div>
        </div>
        </ScrollArea>

        <div className="p-4 border-t border-border/80 bg-card/85 backdrop-blur-xl flex flex-col items-stretch gap-2">
          {/* 主次层级拉开：次级结构化 Prompt 走 luminous secondary，唯一主 CTA 留给一键复制上下文清单 */}
          <Button variant="secondary" fullWidth onClick={handleGeneratePrompt} className="cursor-pointer">
            {promptCopied ? (
              <>
                <Check className="w-4 h-4 text-[color:var(--stage-ink-deliver-text)]" />
                <span>已生成并复制到剪贴板</span>
              </>
            ) : (
              <>
                <ClipboardCopy className="w-4 h-4 text-[color:var(--accent-iris-deep)]" />
                <span>生成结构化 Prompt</span>
              </>
            )}
          </Button>
          <Button variant="primary" fullWidth onClick={handleCopy} className="cursor-pointer">
            {copied ? (
              <>
                <Check className="w-4 h-4" />
                <span>已复制到剪贴板！可直接粘贴回智能体对话</span>
              </>
            ) : (
              <>
                <ClipboardCopy className="w-4 h-4" />
                <span>一键复制上下文清单 ({pointers.length} 项已选)</span>
              </>
            )}
          </Button>
        </div>
      </div>
    </div>
  );
};

