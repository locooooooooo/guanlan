
import type { DecisionResolveRequest, StatementDetailDTO } from '../services/apiTypes';


export type DecisionPriority = 'P0' | 'P1' | 'P2';

/** 状态词（库内口径，与 STATEMENT_STATUS_LABEL 同域） */
export type DecisionBlockStatus = '待确认' | '已确认' | '已否决' | '已搁置' | '已取代';

const DECISION_MARKER_RE =
  /\[((?:P[012])(?:\s*\/\s*P[012])*)\s*[-－—]\s*(待确认|已确认|已否决|已搁置|已取代)\]/;

/** 卡点块（行号锚定；行号 1-based，与 buildMarkdownBlocks 块模型同一坐标系） */
export interface DecisionBlock {
  line: number;
  range: [number, number];
  priorities: DecisionPriority[];
  priority: DecisionPriority;
  blocking: boolean;
  status: DecisionBlockStatus;
  title: string;
  fields: {
    decision?: number;
    confirmer?: number;
    role?: number;
    currentCondition?: number;
    newCondition?: number;
    effectiveScopeDate?: number;
  };
}

const DECISION_FIELD_LABELS: ReadonlyArray<{
  key: keyof DecisionBlock['fields'];
  re: RegExp;
}> = [
  { key: 'decision', re: /^[-*]\s*(?:\*\*)?决定(?:\*\*)?\s*[：:]/ },
  { key: 'confirmer', re: /^[-*]\s*(?:\*\*)?确认人(?:\*\*)?\s*[：:]/ },
  { key: 'role', re: /^[-*]\s*(?:\*\*)?角色(?:\*\*)?\s*[：:]/ },
  { key: 'currentCondition', re: /^[-*]\s*(?:\*\*)?(?:现|现有|当前)运行条件(?:\*\*)?\s*[：:]/ },
  { key: 'newCondition', re: /^[-*]\s*(?:\*\*)?新运行条件(?:\*\*)?\s*[：:]/ },
  { key: 'effectiveScopeDate', re: /^[-*]\s*(?:\*\*)?生效(?:范围与日期|范围|日期)(?:\*\*)?\s*[：:]/ },
];

function parsePriorities(raw: string): DecisionPriority[] {
  return raw
    .split('/')
    .map((p) => p.trim())
    .filter((p): p is DecisionPriority => p === 'P0' || p === 'P1' || p === 'P2');
}

/**
 * 全量卡点块解析（含已定案块——阅读器可据此展示已拍板态）。
 * 保守纪律：代码围栏内的标记是字符串字面量，一律不识别；
 * 区块范围止于标题/围栏/空行/下一标记行。
 */
export function parseDecisionBlocks(markdownContent: string): DecisionBlock[] {
  const lines = (markdownContent || '').split('\n');
  const blocks: DecisionBlock[] = [];

  let i = 0;
  while (i < lines.length) {
    const trimmed = lines[i].trim();
    if (trimmed.startsWith('```')) {
      i++;
      while (i < lines.length && !lines[i].trim().startsWith('```')) i++;
      i++;
      continue;
    }
    const marker = DECISION_MARKER_RE.exec(trimmed);
    if (!marker) {
      i++;
      continue;
    }

    const priorities = parsePriorities(marker[1]);
    const status = marker[2] as DecisionBlockStatus;
    const startLine = i + 1;
    const fields: DecisionBlock['fields'] = {};
    let end = i;

    let j = i + 1;
    while (j < lines.length) {
      const t = lines[j].trim();
      if (!t || t.startsWith('```') || t.startsWith('#')) break;
      if (DECISION_MARKER_RE.test(t)) break;
      for (const { key, re } of DECISION_FIELD_LABELS) {
        if (fields[key] === undefined && re.test(t)) {
          fields[key] = j + 1;
          break;
        }
      }
      j++;
    }
    end = j - 1;

    const title = trimmed
      .replace(/^[-*]\s+/, '')
      .replace(DECISION_MARKER_RE, '')
      .trim();

    blocks.push({
      line: startLine,
      range: [startLine, end + 1],
      priorities,
      priority: priorities[0],
      blocking: priorities.some((p) => p === 'P0' || p === 'P1'),
      status,
      title,
      fields,
    });
    i = j;
  }
  return blocks;
}

/** 待拍板（status==='待确认'）的卡点块 */
export function pendingDecisionBlocksOf(markdownContent: string): DecisionBlock[] {
  return parseDecisionBlocks(markdownContent).filter((b) => b.status === '待确认');
}


const OPTIONS_ANCHOR_RE = /可选方案|推荐理由|备选|候选项|请选择|选项[:：]?$/;
const OPTIONS_LIST_ITEM_RE = /^(?:[-*]|\d+[.)])\s+(?:\[[ xX]\]\s*)?(.+)$/;
const OPTIONS_INLINE_SPLIT_RE = /\s*[、，,;；/]\s*/;
/** 选项条数护栏（提取是启发式，最多取 12 条预设） */
export const DECISION_OPTIONS_MAX = 12;
const OPTIONS_COLLECT_MAX_LINES = 30;

function normalizeOptionText(raw: string): string {
  return raw
    .replace(/_{3,}/g, '')
    .replace(/\s+/g, ' ')
    .replace(/[（(]\s*推荐\s*[))]$/, '')
    .trim();
}

/**
 * 「可选方案 / 推荐理由」预设选项提取（确定性口径）：
 *  - 行内标签形态：`可选方案：A、B、C` → 按行内分隔符切分；
 *  - 章节标题形态：`## 可选方案` 之下的列表项逐条收集（至下一标题/第二个空行/护栏）；
 *  - 「推荐理由：…」整行不进选项（推荐语义由 statement.recommendation / 表单副文承载）；
 *  - 去重、剥填空占位、上限 DECISION_OPTIONS_MAX；无命中返回 []（表单只留自定义输入）。
 */
export function extractDecisionOptions(markdownContent: string): string[] {
  const lines = (markdownContent || '').split('\n');
  const options: string[] = [];
  const seen = new Set<string>();

  const pushOption = (raw: string): void => {
    const text = normalizeOptionText(raw);
    if (!text || /^推荐理由/.test(text)) return;
    if (seen.has(text)) return;
    seen.add(text);
    options.push(text);
  };

  let collecting = false;
  let blankRun = 0;
  for (let idx = 0; idx < lines.length && options.length < DECISION_OPTIONS_MAX; idx++) {
    const trimmed = lines[idx].trim();
    if (trimmed.startsWith('```')) {
      collecting = false;
      continue;
    }
    const isHeading = /^#{1,6}\s/.test(trimmed);
    if (isHeading && OPTIONS_ANCHOR_RE.test(trimmed)) {
      collecting = !/推荐理由/.test(trimmed) || /可选方案|选项/.test(trimmed);
      blankRun = 0;
      continue;
    }
    if (collecting) {
      if (!trimmed) {
        blankRun++;
        if (blankRun >= 2) collecting = false;
        continue;
      }
      blankRun = 0;
      if (isHeading) {
        collecting = false;
        continue;
      }
      const listItem = OPTIONS_LIST_ITEM_RE.exec(trimmed);
      if (listItem) {
        pushOption(listItem[1]);
        continue;
      }
      continue;
    }
    if (isHeading) continue;
    if (/可选方案|备选|候选项/.test(trimmed) && /[：:]/.test(trimmed)) {
      const labeled = /(?:可选方案|备选|候选项)\s*[：:]\s*(.*)$/.exec(trimmed);
      if (labeled) {
        const inline = labeled[1].trim();
        if (!inline) {
          collecting = true;
          blankRun = 0;
          continue;
        }
        for (const part of inline.split(OPTIONS_INLINE_SPLIT_RE)) pushOption(part);
        continue;
      }
    }
    if (OPTIONS_ANCHOR_RE.test(trimmed) && !/推荐理由/.test(trimmed) && !/[：:]/.test(trimmed)) {
      collecting = true;
      blankRun = 0;
    }
  }
  return options.slice(0, DECISION_OPTIONS_MAX);
}


/** 拍板表单值（DecisionResolveCard 的提交形状） */
export interface DecisionResolveFormValues {
  decision: string;
  confirmer: string;
  role: string;
  effectiveScope: string;
  effectiveDate: string;
  note: string;
}

/** 表单值 → 拍板请求体：trim；空可选字段省略键（不发送空串）；decision/confirmer 必填 */
export function buildDecisionResolvePayload(values: DecisionResolveFormValues): DecisionResolveRequest {
  const payload: DecisionResolveRequest = {
    decision: values.decision.trim(),
    confirmer: values.confirmer.trim(),
  };
  const role = values.role.trim();
  if (role) payload.role = role;
  const scope = values.effectiveScope.trim();
  const date = values.effectiveDate.trim();
  if (scope || date) {
    payload.effective_scope = scope && date ? `${scope} · ${date}` : scope || date;
  }
  const note = values.note.trim();
  if (note) payload.note = note;
  if (date) payload.effective_date = date;
  return payload;
}


/**
 * 区块行范围内首个命中陈述（statement.line_start ∈ block.range）。
 * 无命中/空列表 → null（调用方据此禁用提交并如实提示）。
 */
export function matchStatementToBlock(
  statements: readonly StatementDetailDTO[],
  block: DecisionBlock
): StatementDetailDTO | null {
  let best: StatementDetailDTO | null = null;
  for (const st of statements) {
    if (st.line_start < block.range[0] || st.line_start > block.range[1]) continue;
    if (!best || st.line_start < best.line_start) best = st;
  }
  return best;
}


/**
 * 剩余阻塞数：待确认 + blocking(P0/P1) + 不在本会话已拍板集合。
 * resolvedLines 为「本会话已成功拍板的卡点标记行号」——回写落地后新版本内容里
 * 标记会变已确认（parse 自然剔除），会话集合只覆盖内容尚未刷新的窗口。
 */
export function remainingBlockingCount(
  blocks: readonly DecisionBlock[],
  resolvedLines: ReadonlySet<number>
): number {
  return blocks.filter(
    (b) => b.blocking && b.status === '待确认' && !resolvedLines.has(b.line)
  ).length;
}

/** 本会话内是否达成「曾有阻塞 → 现已清零」（从未有阻塞的文档不触发恢复提示） */
export function isBlockingCleared(
  blocks: readonly DecisionBlock[],
  resolvedLines: ReadonlySet<number>
): boolean {
  const blockingPending = blocks.filter((b) => b.blocking);
  if (blockingPending.length === 0) return false;
  return remainingBlockingCount(blocks, resolvedLines) === 0;
}


export const DECISION_IDENTITY_STORAGE_KEY = 'guanlan.decisionIdentity.v1';

export interface DecisionIdentityMemory {
  confirmers: string[];
  roles: string[];
}

const IDENTITY_MEMORY_CAP = 8;

function isValidIdentityMemory(value: unknown): value is DecisionIdentityMemory {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const c = value as Partial<DecisionIdentityMemory>;
  const isStrArr = (a: unknown): a is string[] =>
    Array.isArray(a) && a.every((v) => typeof v === 'string');
  return isStrArr(c.confirmers) && isStrArr(c.roles);
}

/** 读记忆；损坏/隐私模式/无 window（node 测试链）一律空记忆降级 */
export function loadDecisionIdentityMemory(): DecisionIdentityMemory {
  if (typeof window === 'undefined') return { confirmers: [], roles: [] };
  try {
    const raw = window.localStorage.getItem(DECISION_IDENTITY_STORAGE_KEY);
    if (!raw) return { confirmers: [], roles: [] };
    const parsed = JSON.parse(raw) as unknown;
    return isValidIdentityMemory(parsed)
      ? { confirmers: parsed.confirmers, roles: parsed.roles }
      : { confirmers: [], roles: [] };
  } catch {
    return { confirmers: [], roles: [] };
  }
}

function pushRemembered(list: string[], value: string): string[] {
  const v = value.trim();
  if (!v) return list;
  return [v, ...list.filter((x) => x !== v)].slice(0, IDENTITY_MEMORY_CAP);
}

/** 合并写入最近确认人/角色；写失败静默（记忆是增强能力，不阻塞拍板） */
export function rememberDecisionIdentity(
  memory: DecisionIdentityMemory,
  confirmer: string,
  role: string
): DecisionIdentityMemory {
  const next: DecisionIdentityMemory = {
    confirmers: pushRemembered(memory.confirmers, confirmer),
    roles: pushRemembered(memory.roles, role),
  };
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.setItem(
        DECISION_IDENTITY_STORAGE_KEY,
        JSON.stringify(next)
      );
    } catch {
    }
  }
  return next;
}
