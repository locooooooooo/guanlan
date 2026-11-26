

const DECISION_KEYWORD_RE =
  /决策|回执|待确认|请选择|勾选|确认|填写|填入|选项|需要您|需要你|投票/;

const DECISION_SINGLE_CHOICE_RE =
  /单选|二选一|三选一|四选一|择一|只选一[项个]?|选其[一二三四]|请选择(一个|一项|其中一[项个])/;

const DECISION_ZONE_MAX_BRIDGE_LINES = 2;
const DECISION_CONTEXT_LOOKBACK_LINES = 3;
const DECISION_HEADING_SCAN_LIMIT = 200;

const DECISION_OPTION_RE = /^([□☐☑☒])\s*(.*)$/;
const DECISION_TASK_RE = /^-\s+\[([xX ])\]\s+(.+)$/;
const DECISION_FILL_SPLIT_RE = /_{3,}/;

/** 决策表单项（渲染期按行号覆盖对应 block；text 已剥 □/- [ ] 前缀，其余逐字）。 */
export interface DecisionFormItem {
  line: number;
  checkbox?: { initialChecked: boolean };
  radio?: { zoneId: number };
  text: string;
}

type DecisionLineClass =
  | { t: 'option'; checked: boolean; text: string }
  | { t: 'task'; checked: boolean; text: string }
  | { t: 'fill' }
  | { t: 'heading' }
  | { t: 'code' }
  | { t: 'empty' }
  | { t: 'text' };

function classifyDecisionLine(trimmed: string): DecisionLineClass {
  if (!trimmed) return { t: 'empty' };
  if (trimmed.startsWith('#')) return { t: 'heading' };
  const option = DECISION_OPTION_RE.exec(trimmed);
  if (option && option[2].trim()) {
    return {
      t: 'option',
      checked: option[1] === '☑' || option[1] === '☒',
      text: option[2],
    };
  }
  const task = DECISION_TASK_RE.exec(trimmed);
  if (task) {
    return { t: 'task', checked: task[1] !== ' ', text: task[2] };
  }
  if (DECISION_FILL_SPLIT_RE.test(trimmed)) return { t: 'fill' };
  return { t: 'text' };
}

/**
 * 决策回执命中解析（纯函数，可直接单测）：
 * markdownContent → Map<行号, DecisionFormItem>。只产「哪些行是表单项」，
 * 不改 buildMarkdownBlocks 主行模型——未命中行零影响，逐字回退原渲染。
 */
export function parseDecisionFormItems(
  markdownContent: string
): Map<number, DecisionFormItem> {
  const lines = (markdownContent || '').split('\n');
  const items = new Map<number, DecisionFormItem>();

  const classes: DecisionLineClass[] = lines.map(
    (): DecisionLineClass => ({ t: 'text' })
  );
  {
    let inFence = false;
    classes.forEach((_, idx) => {
      const trimmed = lines[idx].trim();
      if (trimmed.startsWith('```')) {
        inFence = !inFence;
        classes[idx] = { t: 'code' };
      } else if (inFence) {
        classes[idx] = { t: 'code' };
      } else {
        classes[idx] = classifyDecisionLine(trimmed);
      }
    });
  }

  let zoneItemLines: number[] = [];
  let zoneBridgeRun = 0;
  let radioZoneSeq = 0;

  const adoptZone = () => {
    if (zoneItemLines.length === 0) return;
    const leadTexts: string[] = [lines[zoneItemLines[0] - 1].trim()];
    let looked = 0;
    for (
      let k = zoneItemLines[0] - 2;
      k >= 0 && looked < DECISION_CONTEXT_LOOKBACK_LINES;
      k--
    ) {
      if (classes[k].t === 'empty') continue;
      looked += 1;
      leadTexts.push(lines[k].trim());
    }
    for (
      let k = zoneItemLines[0] - 2, scanned = 0;
      k >= 0 && scanned < DECISION_HEADING_SCAN_LIMIT;
      k--, scanned++
    ) {
      if (classes[k].t === 'heading') {
        leadTexts.push(lines[k].trim());
        break;
      }
    }
    const leadText = leadTexts.join('\n');
    const hydrate =
      zoneItemLines.length >= 2 || DECISION_KEYWORD_RE.test(leadText);
    if (hydrate) {
      const zoneRadio = DECISION_SINGLE_CHOICE_RE.test(leadText);
      const radioZoneId = zoneRadio ? (radioZoneSeq += 1) : 0;
      for (const lineNo of zoneItemLines) {
        const c = classes[lineNo - 1];
        const trimmed = lines[lineNo - 1].trim();
        if (c.t === 'option' || c.t === 'task') {
          items.set(lineNo, {
            line: lineNo,
            checkbox: { initialChecked: c.checked },
            radio: radioZoneId > 0 ? { zoneId: radioZoneId } : undefined,
            text: c.text,
          });
        } else {
          items.set(lineNo, {
            line: lineNo,
            text: trimmed.replace(/^[-*]\s+/, ''),
          });
        }
      }
    }
    zoneItemLines = [];
    zoneBridgeRun = 0;
  };

  classes.forEach((c, idx) => {
    if (c.t === 'option' || c.t === 'task' || c.t === 'fill') {
      zoneItemLines.push(idx + 1);
      zoneBridgeRun = 0;
    } else if (c.t === 'heading' || c.t === 'code') {
      adoptZone();
    } else if (c.t === 'text') {
      if (zoneItemLines.length > 0) {
        zoneBridgeRun += 1;
        if (zoneBridgeRun > DECISION_ZONE_MAX_BRIDGE_LINES) adoptZone();
      }
    }
  });
  adoptZone();

  return items;
}


export const DECISION_RECEIPT_STORAGE_KEY = 'guanlan.decisionReceipt.v1';

export interface DecisionReceiptSnapshot {
  checks: Record<string, boolean>;
  fills: Record<string, string>;
}

function isValidDecisionSnapshot(value: unknown): value is DecisionReceiptSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Partial<DecisionReceiptSnapshot>;
  if (
    !candidate.checks ||
    !candidate.fills ||
    typeof candidate.checks !== 'object' ||
    typeof candidate.fills !== 'object'
  ) {
    return false;
  }
  for (const v of Object.values(candidate.checks)) {
    if (typeof v !== 'boolean') return false;
  }
  for (const v of Object.values(candidate.fills)) {
    if (typeof v !== 'string') return false;
  }
  return true;
}

/** 按存储键读快照；损坏/不可用/未设置一律 null（调用方按基线种子态渲染）。 */
export function loadDecisionReceiptSnapshot(
  storageKey: string
): DecisionReceiptSnapshot | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(DECISION_RECEIPT_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const entry = (parsed as Record<string, unknown>)[storageKey];
    return isValidDecisionSnapshot(entry) ? entry : null;
  } catch {
    return null;
  }
}

/** 合并写入快照；写失败静默（持久化是增强能力，不是阅读的前置条件）。 */
export function saveDecisionReceiptSnapshot(
  storageKey: string,
  snapshot: DecisionReceiptSnapshot
): void {
  if (typeof window === 'undefined') return;
  try {
    let store: Record<string, unknown> = {};
    const raw = window.localStorage.getItem(DECISION_RECEIPT_STORAGE_KEY);
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as unknown;
        if (parsed && typeof parsed !== 'object' && !Array.isArray(parsed)) {
          store = parsed as Record<string, unknown>;
        }
      } catch {
      }
    }
    store[storageKey] = snapshot;
    window.localStorage.setItem(DECISION_RECEIPT_STORAGE_KEY, JSON.stringify(store));
  } catch {
  }
}


/** 证据篮 payload（onAddDecisionToBasket 可选 prop 的入参形状）。 */
export interface DecisionReceiptBasketPayload {
  file_id: string;
  title: string;
  revision_id: string;
  selectedOptions: string[];
  fillValues: Array<{ prompt: string; value: string }>;
}

/** 填空槽的提示文字：下划线折叠 → 尾冒号剥离（「确认人：___」→「确认人」）。 */
export function fillPromptOf(text: string): string {
  const stripped = text.replace(/_{3,}/g, '').replace(/\s+/g, ' ').trim();
  return stripped.replace(/[：:]\s*$/, '').trim() || text.trim();
}

/**
 * 结构化决策指令 markdown（写剪贴板）：标题 + 来源/版本 + 已勾选 + 填空。
 * 空段（无勾选/无填空）整节省略，不产空标题；来源行按 writtenBack 如实声明
 * （桌面壳桥已回写 → 「已回写原文件」；否则「只读快照，本回执未回写原文件」）。
 */
export function buildDecisionReceiptInstruction(input: {
  title: string;
  filePath: string;
  revisionId: string;
  selectedOptions: string[];
  fillValues: Array<{ prompt: string; value: string }>;
  writtenBack?: boolean;
}): string {
  const head = [
    `## 决策回执：${input.title}`,
    '',
    `- 来源文件：${input.filePath}`,
    `- 版本快照：${input.revisionId}${
      input.writtenBack ? '（已回写原文件）' : '（只读快照，本回执未回写原文件）'
    }`,
  ];
  const blocks: string[] = [];
  if (input.selectedOptions.length > 0) {
    blocks.push(
      ['### 已勾选决策', ...input.selectedOptions.map((t) => `- [x] ${t}`)].join('\n')
    );
  }
  if (input.fillValues.length > 0) {
    blocks.push(
      ['### 填空内容', ...input.fillValues.map((f) => `- ${f.prompt}：${f.value}`)].join(
        '\n'
      )
    );
  }
  return [...head, '', ...blocks].join('\n');
}


/** 桌面壳保存桥入参/返回（main.rs SaveWorkspaceFileRequest/Ok 的 TS 侧形状）。 */
export interface DecisionSaveFileRequest {
  relativePath: string;
  originalContent: string;
  newContent: string;
}

export type DecisionSaveFileBridge = (
  request: DecisionSaveFileRequest
) => Promise<{ saved: boolean; bytes: number }>;

/** 读保存桥：桌面壳经 initialization_script 注入 window.__GUANLAN_SAVE_FILE__；
 *  其余环境（浏览器 dev / 单测 node）为 null。 */
export function readDecisionSaveBridge(): DecisionSaveFileBridge | null {
  if (typeof window === 'undefined') return null;
  return (
    (window as unknown as { __GUANLAN_SAVE_FILE__?: DecisionSaveFileBridge })
      .__GUANLAN_SAVE_FILE__ ?? null
  );
}

/**
 * 回写文本生成（纯函数可单测）：按勾选/填空状态把原文落笔——
 * · 勾选项：行内首个 □/☐ → ☑；markdown 任务行 `[ ]` → `[x]`；
 *   已选态字符（☑/☒/[x]）不再改写（原文已选态如实保留）；
 * · 填空：槽键=`行:槽序`，该行第 k 个 `_{3,}` 段替换为填写值（空值保留原下划线；
 *   替换回调的返回值是字面量，`$` 序列不会被二次解释）；
 * · 未命中行逐字保留（byte 级不变），保证与磁盘内容的冲突比对可靠。
 */
export function buildWrittenBackMarkdown(input: {
  markdownContent: string;
  items: Map<number, DecisionFormItem>;
  checks: Record<string, boolean>;
  fills: Record<string, string>;
}): string {
  const lines = (input.markdownContent || '').split('\n');
  for (const [lineKey, checked] of Object.entries(input.checks)) {
    if (!checked) continue;
    const line = Number(lineKey);
    const raw = lines[line - 1];
    if (raw === undefined || !input.items.get(line)?.checkbox) continue;
    let next = raw;
    if (next.includes('□')) next = next.replace('□', '☑');
    else if (next.includes('☐')) next = next.replace('☐', '☑');
    else if (next.includes('[ ]')) next = next.replace('[ ]', '[x]');
    lines[line - 1] = next;
  }
  const fillsByLine = new Map<number, Map<number, string>>();
  for (const [slotKey, value] of Object.entries(input.fills)) {
    if (!value.trim()) continue;
    const [lineKey, slotKeyPart] = slotKey.split(':');
    const line = Number(lineKey);
    const slot = Number(slotKeyPart);
    if (!Number.isFinite(line) || !Number.isFinite(slot)) continue;
    const perLine = fillsByLine.get(line) ?? new Map<number, string>();
    perLine.set(slot, value.trim());
    fillsByLine.set(line, perLine);
  }
  fillsByLine.forEach((perSlot, line) => {
    const raw = lines[line - 1];
    if (raw === undefined) return;
    let slotIdx = 0;
    lines[line - 1] = raw.replace(/_{3,}/g, (run) => {
      const value = perSlot.get(slotIdx);
      slotIdx += 1;
      return value === undefined ? run : value;
    });
  });
  return lines.join('\n');
}

