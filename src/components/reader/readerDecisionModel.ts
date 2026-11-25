/**
 * 阅读器决策回执纯函数层：
 * 包含命中解析、本机持久化、指令组装与桌面壳写回桥。
 * 消费方为 useReaderController，测试兼容再导出保留在 ReaderView.tsx。
 */

/* ══════════════════════════════════════════════════════════════════════════
   决策回执纯函数层

   背景：决策/回执类文档以 markdown 语法承载表单——「□ A) 选项」复选项、
   「- [ ] …」复选清单、「___」内联填空。本层把「命中判定」收敛为纯函数并刻意保守：

   · 逐行识别三类表单项：□ 复选项（☐/☑/☒ 同族；■ 常作装饰字符不识别）、
     markdown 任务行、3+ 下划线填空行；
   · 以「区带」聚合相邻表单项（最多隔 2 行非标题正文，标题/围栏必断带），
     ≥2 项的区带整体 hydrate（成簇出现即清单形态）；
   · 单项区带仅在决策语境信号命中时放行——自身文本、带前 ≤3 个非空行
     （紧邻标题即其文本）、或最近上方标题文本含 决策/回执/待确认/请选择/
     勾选/确认/填写 等关键词；
   · 代码围栏内一律不 hydrate；其余行（含行内提及「□」的普通文章）逐字
     回退原渲染，绝不吞行、绝不改写文本（选项文本不做标号剥离，防
     「□ 3.5mm 转接头」被误吃标号）。
   ══════════════════════════════════════════════════════════════════════════ */

/** 决策语境关键词：仅用于单项区带与标题的保守放行判定（≥2 项区带不需要它）。 */
const DECISION_KEYWORD_RE =
  /决策|回执|待确认|请选择|勾选|确认|填写|填入|选项|需要您|需要你|投票/;

/** 单选组门控词表：带前语境命中才把区带复选项识别为互斥单选簇（保守，宁缺勿滥——
 *  普通清单绝不因缺词而降级为单选）。 */
const DECISION_SINGLE_CHOICE_RE =
  /单选|二选一|三选一|四选一|择一|只选一[项个]?|选其[一二三四]|请选择(一个|一项|其中一[项个])/;

/** 区带内相邻表单项之间允许的最大非空非标题桥接行数（超过即断带）。 */
const DECISION_ZONE_MAX_BRIDGE_LINES = 2;
/** 单项区带向前回看决策语境信号的非空行数上限。 */
const DECISION_CONTEXT_LOOKBACK_LINES = 3;
/** 最近上方标题的回扫护栏行数（防超长文档线性回扫失控）。 */
const DECISION_HEADING_SCAN_LIMIT = 200;

/** □ 复选项行：捕获标号字符与后续文本（光杆「□」无内容不算选项）。 */
const DECISION_OPTION_RE = /^([□☐☑☒])\s*(.*)$/;
/** markdown 任务行：对齐 buildMarkdownBlocks 的「- [x] 」口径，放宽多空格/缩进/
 *  大写 [X]（模型层吃不到的形态由本层补齐，渲染期覆盖为可交互行）。 */
const DECISION_TASK_RE = /^-\s+\[([xX ])\]\s+(.+)$/;
/** 内联填空：3+ 连续下划线（2 连缀 __ 常作强调记号，不识别——保守）。 */
const DECISION_FILL_SPLIT_RE = /_{3,}/;

/** 决策表单项（渲染期按行号覆盖对应 block；text 已剥 □/- [ ] 前缀，其余逐字）。 */
export interface DecisionFormItem {
  line: number;
  /** 复选能力（□ 选项 / - [ ] 任务）；initialChecked 取原文已选态（☑/☒/[x]） */
  checkbox?: { initialChecked: boolean };
  /** 单选互斥簇（parse 期按带前语境单选措辞门控；同簇多选互斥，渲染为 radio） */
  radio?: { zoneId: number };
  /** 展示文本；渲染期按 _{3,} 再切填空槽（含填空则槽间插内联输入框） */
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

  // 围栏标记先行：围栏起始/结束行与内部行全部标 code（不识别表单项、必断区带——
  // 代码示例里的「□ A) …」是字符串字面量， hydrate 它们属于强改）
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
    // 带前语境证据先统一收集（放行判定与单选组门控共用同一份）：
    // 自身首项文本 + 带前 ≤3 个非空行 + 最近上方标题文本
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
    // 放行判定：① ≥2 项成簇即清单形态；② 单项放行需自身文本、
    // 带前 ≤3 非空行或最近上方标题命中决策关键词
    const hydrate =
      zoneItemLines.length >= 2 || DECISION_KEYWORD_RE.test(leadText);
    if (hydrate) {
      // 单选组门控（保守）：带前语境命中「单选/二选一/择一…」措辞才把本区带
      // 复选项识别为互斥单选簇；普通清单保持复选语义零变化
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
          // 纯填空行：剥一个列表标记（「- 联系人：___」的 - 是项目符号非内容）
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
      // 标题/围栏必断带：新节语境另判，代码块内容绝不入带
      adoptZone();
    } else if (c.t === 'text') {
      if (zoneItemLines.length > 0) {
        zoneBridgeRun += 1;
        if (zoneBridgeRun > DECISION_ZONE_MAX_BRIDGE_LINES) adoptZone();
      }
    }
    // empty 行不打断也不计桥接（表单项间常有空行）
  });
  adoptZone();

  return items;
}

/* ── 勾选状态本机持久化（按 file_id + current_revision_id 隔离） ───────────
   键 guanlan.decisionReceipt.v1 → Record<"fileId::revisionId", 快照>。
   读写全部 try/catch（与 readingStateStore / safeStorage 同口径：隐私模式、
   配额满、损坏 JSON 一律静默降级，绝不让阅读器起不来）；node 无 window 环境按
   未设置处理，确保纯函数单测直接 import 本模块不报错。 */

export const DECISION_RECEIPT_STORAGE_KEY = 'guanlan.decisionReceipt.v1';

export interface DecisionReceiptSnapshot {
  /** 键=表单项行号（同版本内行号稳定；换版本走新快照，不跨版本搬语义） */
  checks: Record<string, boolean>;
  /** 键=`行:槽序`；值=用户填写文本 */
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
        /* 损坏即弃旧表重建，不抛错 */
      }
    }
    store[storageKey] = snapshot;
    window.localStorage.setItem(DECISION_RECEIPT_STORAGE_KEY, JSON.stringify(store));
  } catch {
    /* 隐私模式/配额满：静默 */
  }
}

/* ── 决策指令组装（写剪贴板 / 证据篮共用同一份 payload 形状） ──────────────── */

/** 证据篮 payload（onAddDecisionToBasket 可选 prop 的入参形状）。 */
export interface DecisionReceiptBasketPayload {
  file_id: string;
  title: string;
  revision_id: string;
  /** 已勾选项（原文文本，如「A) 350mm卫生巾」） */
  selectedOptions: string[];
  /** 填空：提示原文（下划线折叠后）+ 用户填写值 */
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

/* ── 保存回写原文件（Tauri 桌面壳命令桥）───────────────────────────────────
   读服务保持只读契约（/api/v1 全 GET）不变；回写走桌面壳原生命令
   save_workspace_file（native/crates/guanlan-desktop/src/main.rs：CRLF 归一的
   乐观并发冲突检测 + 临时文件原子替换）。浏览器/CLI dev 环境无注入桥 →
   按钮诚实禁用（只读快照语义不变，绝不伪造假保存）。 */

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

