import React, { useEffect, useState } from "react";
import {
  Check,
  ClipboardCopy,
  Terminal,
  X,
} from "lucide-react";
import {
  DecisionAssertion,
  FileRecord,
  McpToolName,
  RelationEdge,
  TimelineEvent,
  WorkspaceConfig,
} from "../../types/guanlan";
import {
  executeMcpTool,
  McpToolResponse,
} from "../../utils/guanlanEngine";
import { fetchRevisionContentsBatch } from "../../services/workspaceClient";
import { copyTextWithDesktopFallback } from "../../services/desktopBridge";
import { safeStorageGet } from "../../utils/safeStorage";
import { Button, IconButton, Tabs } from "../ui/primitives";

/* ============================================================================
 * 1. MCP 8-Tool Contract Debugger Modal (§9, §10)
 * ==========================================================================*/
export interface McpConsoleModalProps {
  isOpen: boolean;
  onClose: () => void;
  config: WorkspaceConfig;
  files: FileRecord[];
  events: TimelineEvent[];
  decisions: DecisionAssertion[];
  relations: RelationEdge[];
}

export const McpConsoleModal: React.FC<McpConsoleModalProps> = ({
  isOpen,
  onClose,
  config,
  files,
  events,
  decisions,
  relations,
}) => {
  const [selectedTool, setSelectedTool] = useState<McpToolName>('overview');
  const [queryParam, setQueryParam] = useState<string>('决策');
  // 不再预设演示样本 ID；默认选中当前文件列表的第一个文件
  const [fileIdParam, setFileIdParam] = useState<string>('');
  const [revisionIdParam, setRevisionIdParam] = useState<string>('');
  const [pathOverride, setPathOverride] = useState<string>('');
  const [simulateRootInUse, setSimulateRootInUse] = useState<boolean>(false);
  const [simulateStaleGen, setSimulateStaleGen] = useState<boolean>(false);
  const [simulateDiskDrift, setSimulateDiskHashDrift] = useState<boolean>(false);

  // T01：/scan 去 MD 内联后，search/read/diff 工具的正文按需回退缓存（revision_id → 正文）。
  // 镜像 ReaderView 的按需回退模式：先预取缺失正文，再喂给 executeMcpTool 的 contentCache。
  const [toolContentCache, setToolContentCache] = useState<Record<string, string>>({});
  const [toolFetchFailed, setToolFetchFailed] = useState<Record<string, boolean>>({});

  // 注意：hooks 必须在提前 return 之前声明
  useEffect(() => {
    if (!isOpen) return;
    const missing: string[] = [];
    const pushRevision = (file: FileRecord, revisionId?: string) => {
      const id = revisionId || file.current_revision_id;
      if (!id) return;
      const rev = file.revisions.find((r) => r.revision_id === id);
      if (!rev || !rev.snapshotAvailable || rev.markdownContent) return;
      if (toolContentCache[id] !== undefined || toolFetchFailed[id]) return;
      missing.push(id);
    };
    if (selectedTool === 'search') {
      // 批次一调整②（方案 §5）：全库批量补正文的旧链路已移除——search 保持 guanlanEngine
      // 本地计算，但只基于已取回的数据（文件名/路径 + 已并入缓存的正文）；
      // 全文检索待批次三 GET /api/v1/search 有界检索承接（契约 §3.2）
    } else if (selectedTool === 'read' || selectedTool === 'diff') {
      // read/diff 仅补「当前文件版本链范围」的正文（过渡通道允许范围）
      const target = files.find(
        (f) => f.file_id === (fileIdParam || files[0]?.file_id || '')
      );
      if (target && target.format === 'md') {
        if (selectedTool === 'diff') {
          // diff 缺省窗口为 [第一版, 当前版]
          pushRevision(target, target.revisions[0]?.revision_id);
          pushRevision(target, target.current_revision_id);
        } else {
          pushRevision(target, revisionIdParam || undefined);
        }
      }
    }
    if (missing.length === 0) return;
    let cancelled = false;
    void fetchRevisionContentsBatch(missing, toolContentCache).then(
      ({ contents, failed }) => {
        if (cancelled) return;
        if (Object.keys(contents).length > 0) {
          setToolContentCache((prev) => ({ ...prev, ...contents }));
        }
        if (Object.keys(failed).length > 0) {
          setToolFetchFailed((prev) => ({
            ...prev,
            ...Object.fromEntries(Object.keys(failed).map((id) => [id, true])),
          }));
        }
      }
    );
    return () => {
      cancelled = true;
    };
  }, [
    isOpen,
    selectedTool,
    fileIdParam,
    revisionIdParam,
    files,
    toolContentCache,
    toolFetchFailed,
  ]);

  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  // P0-4 提示文本治理：弹层与 TopHeader 入口钮同键门控（guanlan.debug.mcp），
  // 默认对用户隐藏——§9/§10 章节号随门控隐去，标题文案不改（开发向）。
  // 开法：控制台执行 localStorage.setItem('guanlan.debug.mcp', '1') 后刷新。
  if (safeStorageGet('guanlan.debug.mcp') !== '1') return null;

  // 渲染与调用统一走真实文件列表：fileIdParam 为空时回退到第一个文件，无文件则为空串
  const effectiveFileId = fileIdParam || files[0]?.file_id || '';
  // 快照已淘汰的版本（snapshotAvailable === false）取自真实数据，用于演示 REVISION_UNAVAILABLE
  const evictedRevision = files
    .flatMap((f) =>
      f.revisions
        .filter((r) => r.snapshotAvailable === false)
        .map((r) => ({ fileId: f.file_id, revisionId: r.revision_id }))
    )[0];

  const toolDescriptions: Record<McpToolName, { desc: string; inputs: string }> = {
    overview: {
      desc: '返回扫描范围、索引覆盖、近期变化与明确的未决事项计数',
      inputs: 'since, limit',
    },
    search: {
      desc: '双字切分 + 短语回源核验查找内容、文件或任务编号，附带 coverage 标记',
      inputs: 'query, format, topic, cursor',
    },
    read: {
      desc: '获取大纲、章节、行段或指定版本快照（越界返回 OUT_OF_SCOPE，已淘汰快照返回 REVISION_UNAVAILABLE）',
      inputs: 'file_id, revision_id, view, locator',
    },
    timeline: {
      desc: '按 observed_at 分页获取观察事件，严格区分三种时间',
      inputs: 'since, until, kind, file_id, cursor',
    },
    diff: {
      desc: '比较两次版本，说明可比较的范围与变化的章节',
      inputs: 'file_id, from_revision, to_revision',
    },
    decisions: {
      desc: '查看明确决策和冲突来源（按命名空间严格隔离 Q03，默认过滤疑似决策候选）',
      inputs: 'status, scope, decision_id, cursor',
    },
    relations: {
      desc: '获取引用、版本演进、决策依据及局部一跳/二跳关系图（节点上限 80）',
      inputs: 'subject_id, relation_type, depth, cursor',
    },
    open_reader: {
      desc: '按需启动 127.0.0.1 随机端口阅读会话并返回短期凭据入口（具副作用）',
      inputs: 'file_id, revision_id, locator',
    },
  };

  const response: McpToolResponse = executeMcpTool(
    {
      tool: selectedTool,
      params: {
        query: queryParam,
        file_id: effectiveFileId,
        revision_id: revisionIdParam || undefined,
        path: pathOverride || undefined,
        subject_id: effectiveFileId,
        depth: 2,
      },
      clientIndexGeneration: simulateStaleGen
        ? config.runtimeStatus.indexGeneration - 1
        : config.runtimeStatus.indexGeneration,
      simulateRootInUse,
      simulateDiskHashDrift: simulateDiskDrift,
    },
    { config, files, events, decisions, relations },
    // T01：MD 正文不再内联——search/read/diff 经 contentCache 按需回退
    { contentCache: toolContentCache }
  );

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="MCP 工具契约与错误边界调试台"
      data-esc-layer="open"
      className="glx-backdrop-in fixed inset-0 z-50 bg-[color:var(--ink-anchor)]/38 dark:bg-black/62 backdrop-blur-sm flex items-center justify-center p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        data-dialog-nested-stack=""
        style={{ '--nested-dialogs': 0 } as React.CSSProperties}
        className="glass-pop glx-modal-in rounded-2xl border border-border/80 w-full max-w-4xl max-h-[88vh] flex flex-col overflow-hidden text-foreground"
      >
        <div className="px-6 py-4 bg-card/85 backdrop-blur-md border-b border-border/80 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <span className="inline-flex size-8 items-center justify-center rounded-[10px] bg-[color:color-mix(in_srgb,var(--accent-iris)_12%,transparent)] text-[color:var(--accent-iris-deep)]">
              <Terminal className="w-4 h-4" />
            </span>
            <h2 className="text-[length:var(--text-item-title)] leading-[var(--lh-item-title)] font-semibold tracking-[-0.01em]">
              MCP 工具契约与 Magpie 接入边界验证 (§9, §10)
            </h2>
          </div>
          <IconButton label="关闭 MCP 调试台" onClick={onClose} className="cursor-pointer">
            <X />
          </IconButton>
        </div>

        <div className="flex-1 overflow-y-auto p-6 space-y-5">
          {/* 8 Standard Tools Selector——§4.2 ModeTabs（工具选择＝切换下方参数/响应面板，
              标线为界；每卡 inputs 预览行收敛为选中工具的单行 inputs，信息不丢失） */}
          <div className="space-y-1.5">
            <Tabs
              ariaLabel="MCP 工具选择"
              active={selectedTool}
              onChange={(key) => {
                setSelectedTool(key as McpToolName);
                setSimulateRootInUse(false);
                setSimulateStaleGen(false);
                setSimulateDiskHashDrift(false);
                setPathOverride('');
                setRevisionIdParam('');
              }}
              className="flex-wrap"
              items={(Object.keys(toolDescriptions) as McpToolName[]).map((t) => ({
                key: t,
                label: <span title={`inputs: ${toolDescriptions[t].inputs}`}>{t}</span>,
              }))}
            />
            <div className="font-mono text-[length:var(--text-micro)] leading-[var(--lh-micro)] text-[color:var(--ink-soft)] tabular-nums">
              inputs: {toolDescriptions[selectedTool].inputs}
            </div>
          </div>

          {/* Preset Boundary Test Cases——杂钮归 Button·secondary（§4.1 映射表 #10） */}
          <div className="p-3.5 rounded-[var(--r-block)] border border-[color:var(--glass-hairline)] bg-white/60 space-y-2.5 text-xs">
            <div className="font-semibold text-[color:var(--ink-strong)]">
              一键验证标准错误类型与协议边界（stdout 仅输出协议消息，诊断输出到 stderr）：
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  setSelectedTool('read');
                  setPathOverride('../../Windows/System32/drivers/etc/hosts');
                  setSimulateRootInUse(false);
                  setSimulateStaleGen(false);
                }}
                className="cursor-pointer"
              >
                测试 OUT_OF_SCOPE (路径越界)
              </Button>

              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  setSelectedTool('read');
                  if (evictedRevision) {
                    setFileIdParam(evictedRevision.fileId);
                    setRevisionIdParam(evictedRevision.revisionId);
                  }
                  setPathOverride('');
                  setSimulateRootInUse(false);
                  setSimulateStaleGen(false);
                }}
                className="cursor-pointer"
              >
                测试 REVISION_UNAVAILABLE (已淘汰旧快照)
              </Button>

              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  setSimulateStaleGen(true);
                  setSimulateRootInUse(false);
                }}
                className="cursor-pointer"
              >
                测试 INDEX_STALE (代际游标过期)
              </Button>

              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  setSimulateRootInUse(true);
                  setSimulateStaleGen(false);
                }}
                className="cursor-pointer"
              >
                测试 ROOT_IN_USE (同工程单写入锁冲突)
              </Button>

              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  setSimulateRootInUse(false);
                  setSimulateStaleGen(false);
                  setSimulateDiskHashDrift(false);
                  setPathOverride('');
                  setRevisionIdParam('');
                }}
                className="cursor-pointer"
              >
                恢复正常调用
              </Button>
            </div>
          </div>

          {/* Parameter Inputs */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs">
            <label className="space-y-1">
              <span className="text-[color:var(--ink-soft)]">目标 file_id / subject_id</span>
              <select
                value={effectiveFileId}
                onChange={(e) => setFileIdParam(e.target.value)}
                className="glass-input w-full rounded-[var(--r-ctl)] px-2.5 py-1.5 font-mono"
              >
                {files.map((f) => (
                  <option key={f.file_id} value={f.file_id}>
                    {f.file_id} ({f.title})
                  </option>
                ))}
              </select>
            </label>

            <label className="space-y-1">
              <span className="text-[color:var(--ink-soft)]">search query 参数</span>
              <input
                type="text"
                value={queryParam}
                onChange={(e) => setQueryParam(e.target.value)}
                className="glass-input w-full rounded-[var(--r-ctl)] px-2.5 py-1.5"
              />
            </label>

            <label className="space-y-1">
              <span className="text-[color:var(--ink-soft)]">指定 revision_id（留空读最新）</span>
              <input
                type="text"
                value={revisionIdParam}
                onChange={(e) => setRevisionIdParam(e.target.value)}
                placeholder="留空读取最新版本"
                className="glass-input w-full rounded-[var(--r-ctl)] px-2.5 py-1.5 font-mono"
              />
            </label>
          </div>

          {/* JSON Response Output */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between text-xs font-mono">
              <span className="text-[color:var(--ink-soft)]">
                工具说明：{toolDescriptions[selectedTool].desc}
              </span>
              {/* 状态字走语义 -text 深档（§3.1 六色双层：文字不用 graphic 原值） */}
              <span
                className={
                  response.ok
                    ? 'text-[color:var(--stage-ink-deliver-text)]'
                    : 'text-[color:var(--stage-ink-exec-text)]'
                }
              >
                {response.ok ? 'STATUS: OK' : `ERROR: ${response.error_code}`}
              </span>
            </div>
            <pre className="p-4 rounded-[var(--r-block)] border border-[color:var(--glass-hairline)] bg-white/60 text-xs font-mono text-[color:var(--ink-strong)] overflow-x-auto max-h-80">
              {JSON.stringify(response, null, 2)}
            </pre>
          </div>
        </div>
      </div>
    </div>
  );
};

