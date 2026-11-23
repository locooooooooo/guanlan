/**
 * Inline 拍板闭环 · 卡点块解析与拍板表单纯函数层（PRD 3.3 / 方案 F5）。
 *
 * 职责（全部纯函数 + 本机记忆存储，禁 import .css / React——node --test 直跑约束）：
 *  - parseDecisionBlocks：识别 `[P0/P1/P2 - 待确认|已确认|…]` 卡点标记与
 *    PRD 3.3 标准字段行（决定/确认人/角色/现·新运行条件/生效范围与日期），
 *    产出行号锚定的区块模型（阅读器按块模型行号原位渲染表单）；
 *  - extractDecisionOptions：从「可选方案 / 推荐理由」章节提取决定下拉的预设选项
 *    （PRD 3.3：自动提取文档中选项作为预设，并支持自定义输入——自定义在表单层）；
 *  - buildDecisionResolvePayload：表单值 → 契约 C DecisionResolveRequest
 *    （trim、空可选字段省略键——不发送空串）；
 *  - matchStatementToBlock：服务端陈述（GET /statements，line_start 行号）与本地
 *    解析区块的匹配（区块行范围内首个命中）；无服务端陈述 → null（表单诚实降级）；
 *  - remainingBlockingCount / isBlockingCleared：本会话已拍板集合下的剩余阻塞
 *    （P0/P1）计数与清零判定（AC-03 长任务恢复提示的本地口径）；
 *  - 确认人/角色本机记忆：无成员数据源（方案登记偏差）——自由文本 + localStorage
 *    最近值点选（datalist 预填），读写全 try/catch，node 无 window 环境安全降级。
 *
 * 铁律：本层不写文件、不发请求——.md 占位符替换由后端拍板回写 job（CAS）完成，
 * 前端只组装载荷与展示结果（契约 C：恒 202，无 409 路径）。
 */

import type { DecisionResolveRequest, StatementDetailDTO } from '../services/apiTypes';

// ================= 卡点标记解析 =================

export type DecisionPriority = 'P0' | 'P1' | 'P2';

/** PRD 3.2/3.3 状态词（库内口径，与 STATEMENT_STATUS_LABEL 同域） */
export type DecisionBlockStatus = '待确认' | '已确认' | '已否决' | '已搁置' | '已取代';

/**
 * 卡点标记：`[P1 - 待确认]` 形态。容忍全角连字符与空格变体；
 * 组合优先级（如 `[P0/P1 - 待确认]`）按列出顺序取首个为代表性优先级，
 * blocking = 任一为 P0/P1（P2 不构成阻塞门禁，契约 stateMachine 节）。
 */
const DECISION_MARKER_RE =
  /\[((?:P[012])(?:\s*\/\s*P[012])*)\s*[-－—]\s*(待确认|已确认|已否决|已搁置|已取代)\]/;

/** 卡点块（行号锚定；行号 1-based，与 buildMarkdownBlocks 块模型同一坐标系） */
export interface DecisionBlock {
  /** 标记行（1-based） */
  line: number;
  /** 区块行范围 [start, end]（含标记行与字段行；标题/围栏/空行/下一标记断开） */
  range: [number, number];
  priorities: DecisionPriority[];
  /** 代表性优先级（组合标记取首个；单标记即其自身） */
  priority: DecisionPriority;
  /** 任一优先级为 P0/P1（阻塞门禁语义） */
  blocking: boolean;
  status: DecisionBlockStatus;
  /** 标记行去掉标记与列表符后的标题文本 */
  title: string;
  /** PRD 3.3 标准字段行号（区块内首个命中；缺省字段不出键） */
  fields: {
    decision?: number;
    confirmer?: number;
    role?: number;
    currentCondition?: number;
    newCondition?: number;
    effectiveScopeDate?: number;
  };
}

/** 字段标签 → 键（顺序即匹配优先级；前缀词容忍加粗/列表符） */
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
      // 围栏整段跳过（与 ReaderView.parseDecisionFormItems 同纪律：字面量不识别）
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
    let end = i; // 0-based 游标，结束 +1 回写

    // 区块延伸：标记行之后的字段行（遇标题/围栏/空行/下一标记收口）
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

// ================= 可选方案 / 推荐理由 提取 =================

/** 选项锚定行：章节标题或行内标签（含「可选方案/推荐理由/选项」字样） */
const OPTIONS_ANCHOR_RE = /可选方案|推荐理由|备选|候选项|请选择|选项[:：]?$/;
/** 列表项（含 □ 复选与任务形态） */
const OPTIONS_LIST_ITEM_RE = /^(?:[-*]|\d+[.)])\s+(?:\[[ xX]\]\s*)?(.+)$/;
/** 选项分隔符（行内列举：A、B / A，B / A; B / A；B / A / B） */
const OPTIONS_INLINE_SPLIT_RE = /\s*[、，,;；/]\s*/;
/** 选项条数护栏（提取是启发式，最多取 12 条预设） */
export const DECISION_OPTIONS_MAX = 12;
/** 列表收集越界护栏（标题后最多扫描 30 行） */
const OPTIONS_COLLECT_MAX_LINES = 30;

function normalizeOptionText(raw: string): string {
  return raw
    .replace(/_{3,}/g, '') // 填空占位不是选项
    .replace(/\s+/g, ' ')
    .replace(/[（(]\s*推荐\s*[))]$/, '') // 尾注「（推荐）」归推荐语义，不进选项词面
    .trim();
}

/**
 * 「可选方案 / 推荐理由」预设选项提取（PRD 3.3，确定性口径）：
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
      // 非列表正文行不收集（保守：章节里夹叙述段不当选项）
      continue;
    }
    if (isHeading) continue;
    // 行内标签形态（仅「可选方案/选项」；「推荐理由：」整行跳过不进选项）
    if (/可选方案|备选|候选项/.test(trimmed) && /[：:]/.test(trimmed)) {
      const labeled = /(?:可选方案|备选|候选项)\s*[：:]\s*(.*)$/.exec(trimmed);
      if (labeled) {
        const inline = labeled[1].trim();
        if (!inline) {
          // 「可选方案：」冒号后为空 = 章节收集起点（选项在下方列表）
          collecting = true;
          blankRun = 0;
          continue;
        }
        for (const part of inline.split(OPTIONS_INLINE_SPLIT_RE)) pushOption(part);
        continue;
      }
    }
    if (OPTIONS_ANCHOR_RE.test(trimmed) && !/推荐理由/.test(trimmed) && !/[：:]/.test(trimmed)) {
      // 「可选方案」独立行（非标题非标签）视作列表收集起点
      collecting = true;
      blankRun = 0;
    }
  }
  return options.slice(0, DECISION_OPTIONS_MAX);
}

// ================= 拍板载荷（契约 C） =================

/** 拍板表单值（DecisionResolveCard 的提交形状） */
export interface DecisionResolveFormValues {
  decision: string;
  confirmer: string;
  role: string;
  /** 影响范围标签（如「全量专项 / 仅当前分支」） */
  effectiveScope: string;
  /** YYYY-MM-DD（input[type=date] 原生值） */
  effectiveDate: string;
  note: string;
}

/** 表单值 → 契约 C 请求体：trim；空可选字段省略键（不发送空串）；decision/confirmer 必填 */
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

// ================= 陈述匹配（服务端 statements ↔ 本地区块） =================

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

// ================= 阻塞清零判定（AC-03 本地口径） =================

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

// ================= 确认人 / 角色本机记忆（无成员数据源，偏差登记） =================

export const DECISION_IDENTITY_STORAGE_KEY = 'guanlan.decisionIdentity.v1';

export interface DecisionIdentityMemory {
  /** 最近使用的确认人（新者在前，去重，上限 8——点选来源） */
  confirmers: string[];
  /** 最近使用的角色（同上） */
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
      /* 隐私模式/配额满：静默 */
    }
  }
  return next;
}
