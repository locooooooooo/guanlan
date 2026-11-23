/**
 * 证道阁双模导出（PRD 4.3 / 方案 F4，纯函数层）。
 *
 *  - 模式 A：结构化 <guanlan_context> 提示词清单（XML 标签结构逐字对齐 PRD 4.3
 *    示例：objective / confirmed_decisions / pending_blockers(count) /
 *    reference_files(count) / writeback_protocol）；
 *  - 模式 B：guanlan-mcp/v1 MCP 载荷（PRD 4.3 JSON 形状：session_checkpoint_id /
 *    workspace_root / initiative / context_bundle(uri=guanlan://<path>，hash=
 *    sha256:<前16>) / allowed_mcp_tools(4 工具) / guardrails）；
 *  - mcp.json 配置模板（MCP 连接自检的「一键复制」产物）。
 *
 * 纪律：纯函数（node --test 直跑）；服务端 POST /context（契约 B）落地后 markdown
 * 与 payload 将以服务端响应为唯一导出源（响应含同构 markdown/payload 字段），
 * 本层是其离线降级实现——双模结构与契约 B DTO 词表逐字对齐。
 */

import type { ContextMcpPayload, McpHostTarget } from '../services/apiTypes';
import { sanitizeContextText } from './contextSanitizer';

// ================= 模式 A：Markdown 提示词清单（PRD 4.3 结构 A） =================

export interface GuanlanContextDecisionLine {
  /** 'P1' | 'P0' … */
  priority: string;
  /** 库内状态词（已确认/待确认…） */
  statusLabel: string;
  /** 决定/问题正文 */
  text: string;
  confirmer?: string | null;
  effectiveDate?: string | null;
}

export interface GuanlanContextBlockerLine {
  priority: string;
  statusLabel: string;
  text: string;
  /** `相对路径#L42` 形态的文件锚点 */
  fileRef?: string | null;
}

export interface GuanlanContextReferenceLine {
  path: string;
  /** 注入粒度标识（兼容既有 全文/摘要/引用 及 E03 四档语义词） */
  granularityLabel: '全文' | '摘要' | '引用' | '仅大纲与结论' | '仅变更 Diff' | '仅元数据路径';
  versionLabel?: string | null;
  stateLabel?: string | null;
}

export interface GuanlanContextMarkdownInput {
  workspaceRoot: string;
  initiative?: { name: string; stage: string } | null;
  /** 目标段（缺省用 PRD 默认话术） */
  objective?: string;
  confirmedDecisions: readonly GuanlanContextDecisionLine[];
  pendingBlockers: readonly GuanlanContextBlockerLine[];
  referenceFiles: readonly GuanlanContextReferenceLine[];
}

/** writeback_protocol 段（PRD 4.3 逐字话术） */
export const WRITEBACK_PROTOCOL_TEXT =
  '执行完成后，请勿仅在对话中输出总结。请直接修改上述本地 Markdown 文件的对应章节，' +
  '并在文件头部 YAML Frontmatter 中递增 `revision` 版本号，以便观澜后台 File Watcher ' +
  '自动捕获并沉淀新版本 Checkpoint。';

function escapeAttr(value: string): string {
  return value.replace(/"/g, '&quot;');
}

function indentLine(text: string): string {
  return `  ${text}`;
}

/**
 * 模式 A 结构化清单。五段恒在（空集合输出空段体），pending_blockers 与
 * reference_files 带 count 属性（PRD 示例口径）。
 */
export function buildGuanlanContextMarkdown(input: GuanlanContextMarkdownInput): string {
  const attrs = [`workspace="${escapeAttr(input.workspaceRoot)}"`];
  if (input.initiative) {
    attrs.push(`initiative="${escapeAttr(input.initiative.name)}"`);
    attrs.push(`stage="${escapeAttr(input.initiative.stage)}"`);
  }
  const objective =
    input.objective?.trim() ||
    '请阅读以下观澜工作区上下文，基于已拍板决策推进当前阶段长任务，并在完成后按规范更新对应文档。';

  const confirmed = input.confirmedDecisions.map((d) => {
    const bits = [`[${d.priority}-${d.statusLabel}]`, d.text];
    const meta: string[] = [];
    if (d.confirmer) meta.push(`确认人：${d.confirmer}`);
    if (d.effectiveDate) meta.push(`生效日期：${d.effectiveDate}`);
    return indentLine(`- ${bits.join(' ')}${meta.length ? `（${meta.join('，')}）` : ''}`);
  });

  const pending = input.pendingBlockers.map((b) => {
    const ref = b.fileRef ? `（文件路径：${b.fileRef}）` : '';
    return indentLine(`- [${b.priority}-${b.statusLabel}] ${b.text}${ref}`);
  });

  const references = input.referenceFiles.map((r, idx) => {
    const meta: string[] = [];
    if (r.versionLabel) meta.push(r.versionLabel);
    if (r.stateLabel) meta.push(r.stateLabel);
    return indentLine(
      `${idx + 1}. [${r.granularityLabel}] ${r.path}${meta.length ? ` (${meta.join(' · ')})` : ''}`
    );
  });

  const raw = [
    `<guanlan_context ${attrs.join(' ')}>`,
    '  <objective>',
    `    ${objective}`,
    '  </objective>',
    '',
    '  <confirmed_decisions>',
    ...confirmed,
    '  </confirmed_decisions>',
    '',
    `  <pending_blockers count="${input.pendingBlockers.length}">`,
    ...pending,
    '  </pending_blockers>',
    '',
    `  <reference_files count="${input.referenceFiles.length}">`,
    ...references,
    '  </reference_files>',
    '',
    '  <writeback_protocol>',
    `    ${WRITEBACK_PROTOCOL_TEXT}`,
    '  </writeback_protocol>',
    '</guanlan_context>',
  ].join('\n');
  // E03 停机红线护栏：离线降级路径同样强制脱敏，绝不混入密钥/环境变量
  return sanitizeContextText(raw).text;
}

// ================= 模式 B：guanlan-mcp/v1 载荷（PRD 4.3 JSON） =================

/** 允许的 MCP 工具面（PRD 4.3 四工具，顺序逐字） */
export const GUANLAN_MCP_ALLOWED_TOOLS: readonly string[] = [
  'guanlan.read_artifact',
  'guanlan.propose_revision',
  'guanlan.resolve_decision',
  'guanlan.commit_checkpoint',
];

export interface McpBundleEntry {
  /** 相对路径（载荷内转 guanlan://<path>） */
  path: string;
  granularity: string;
  /** 'v2' 等版本标签 */
  versionLabel?: string | null;
  /** 裸哈希（十六进制；载荷内取前 16 位拼 sha256: 前缀） */
  contentHash?: string | null;
}

export interface McpPayloadInput {
  workspaceRoot: string;
  initiative?: { id: string; name: string; stage: string } | null;
  contextBundle: readonly McpBundleEntry[];
  sessionCheckpointId?: string | null;
}

/** guanlan-mcp/v1 载荷（apiTypes.ContextMcpPayload 逐字形状） */
export function buildMcpPayload(input: McpPayloadInput): ContextMcpPayload {
  return {
    protocol: 'guanlan-mcp/v1',
    session_checkpoint_id: input.sessionCheckpointId ?? null,
    workspace_root: input.workspaceRoot,
    initiative: input.initiative
      ? {
          id: input.initiative.id,
          name: input.initiative.name,
          current_stage: input.initiative.stage,
        }
      : null,
    context_bundle: input.contextBundle.map((entry) => ({
      uri: `guanlan://${entry.path}`,
      granularity: entry.granularity,
      version: entry.versionLabel ?? '',
      hash: entry.contentHash ? `sha256:${entry.contentHash.slice(0, 16)}` : 'sha256:',
    })),
    allowed_mcp_tools: [...GUANLAN_MCP_ALLOWED_TOOLS],
    guardrails: {
      block_write_on_unresolved_p0: true,
      require_version_bump: true,
    },
  };
}

// ================= mcp.json 配置模板（连接自检一键复制） =================

/** PRD 4.3 文档值端点（显式 serve --port 39120 时成立；缺省 serve 端口内核随机分配，
 *  权威值在启动 stdout 的 GUANLAN_ENDPOINT 行——代理不猜端口，模板允许用户改写） */
export const GUANLAN_MCP_DEFAULT_ENDPOINT = 'http://127.0.0.1:39120';

/**
 * mcp.json 模板（stdio 代理）：guanlan mcp 子命令 + GUANLAN_ENDPOINT 环境变量。
 * 末尾附 _guanlan_hint 说明字段（消费方可删），登记 PRD 对齐偏差（固定端口需显式指定）。
 */
export function buildMcpJsonConfig(endpoint: string = GUANLAN_MCP_DEFAULT_ENDPOINT): string {
  return JSON.stringify(
    {
      mcpServers: {
        guanlan: {
          command: 'guanlan',
          args: ['mcp'],
          env: {
            GUANLAN_ENDPOINT: endpoint,
          },
        },
      },
      _guanlan_hint:
        '端点默认 http://127.0.0.1:39120（需 `guanlan serve --port 39120` 显式固定；' +
        '缺省 serve 端口为内核随机分配，权威值以启动输出 GUANLAN_ENDPOINT 行为准）',
    },
    null,
    2
  );
}

// ================= E03：主流宿主 .mcp.json 零冷启动配置（ZCode / Claude Code / Cursor） =================

export interface McpHostTargetMeta {
  id: McpHostTarget;
  label: string;
  targetPath: string;
  description: string;
}

export const MCP_HOST_TARGETS: readonly McpHostTargetMeta[] = [
  {
    id: 'zcode',
    label: 'ZCode',
    targetPath: '.mcp.json',
    description: '工作区根目录 .mcp.json（stdio 代理）',
  },
  {
    id: 'claude_code',
    label: 'Claude Code',
    targetPath: '.mcp.json',
    description: '项目级 .mcp.json（含 type: "stdio"）',
  },
  {
    id: 'cursor',
    label: 'Cursor',
    targetPath: '.cursor/mcp.json',
    description: '工作区 .cursor/mcp.json（Cursor MCP）',
  },
];

/** 校验并归一本地回环端点（停机红线：拒绝远程 URL，仅允许 127.0.0.1 / localhost） */
export function normalizeLoopbackEndpoint(raw?: string | null): string | null {
  const trimmed = (raw ?? '').trim().replace(/\/+$/, '');
  if (!trimmed) return GUANLAN_MCP_DEFAULT_ENDPOINT;
  const match = /^http:\/\/(127\.0\.0\.1|localhost):(\d{1,5})$/.exec(trimmed);
  if (!match) return null;
  const port = Number(match[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return trimmed;
}

function buildGuanlanServerEntry(host: McpHostTarget, endpoint: string): Record<string, unknown> {
  // 严格只放 GUANLAN_ENDPOINT，绝不注入任何宿主环境变量或本机密钥
  if (host === 'claude_code') {
    return {
      type: 'stdio',
      command: 'guanlan',
      args: ['mcp'],
      env: { GUANLAN_ENDPOINT: endpoint },
    };
  }
  return {
    command: 'guanlan',
    args: ['mcp'],
    env: { GUANLAN_ENDPOINT: endpoint },
  };
}

/** 生成指定宿主（ZCode / Claude Code / Cursor）的干净 JSON 配置 */
export function buildHostMcpJsonConfig(
  host: McpHostTarget,
  endpoint: string = GUANLAN_MCP_DEFAULT_ENDPOINT
): string {
  const safeEndpoint = normalizeLoopbackEndpoint(endpoint) ?? GUANLAN_MCP_DEFAULT_ENDPOINT;
  return JSON.stringify(
    {
      mcpServers: {
        guanlan: buildGuanlanServerEntry(host, safeEndpoint),
      },
    },
    null,
    2
  );
}

/** 纯函数无损合并现有宿主配置文件（保留其他 mcpServers，仅更新 guanlan 条目；畸形 JSON 拒绝覆写） */
export function mergeMcpHostConfigJson(
  existingRaw: string | null | undefined,
  host: McpHostTarget,
  endpoint: string = GUANLAN_MCP_DEFAULT_ENDPOINT
): { ok: true; json: string; mergedExisting: boolean } | { ok: false; error: string } {
  const safeEndpoint = normalizeLoopbackEndpoint(endpoint);
  if (!safeEndpoint) {
    return { ok: false, error: `仅允许本地回环端点（http://127.0.0.1:<port> 或 http://localhost:<port>）` };
  }
  let root: Record<string, unknown> = {};
  let mergedExisting = false;
  const trimmed = (existingRaw ?? '').trim();
  if (trimmed) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { ok: false, error: '现有宿主配置文件根节点不是 JSON 对象，已安全中止' };
      }
      root = { ...(parsed as Record<string, unknown>) };
      mergedExisting = true;
    } catch (err) {
      return {
        ok: false,
        error: `现有宿主配置 JSON 解析失败（${err instanceof Error ? err.message : String(err)}），已安全中止`,
      };
    }
  }
  const existingServers = root.mcpServers;
  if (
    existingServers !== undefined &&
    (!existingServers || typeof existingServers !== 'object' || Array.isArray(existingServers))
  ) {
    return { ok: false, error: '现有宿主配置 mcpServers 字段不是对象，已安全中止' };
  }
  root.mcpServers = {
    ...((existingServers as Record<string, unknown> | undefined) ?? {}),
    guanlan: buildGuanlanServerEntry(host, safeEndpoint),
  };
  return {
    ok: true,
    json: `${JSON.stringify(root, null, 2)}\n`,
    mergedExisting,
  };
}
