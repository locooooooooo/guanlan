import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { CSSProperties } from 'react';
import * as d3 from 'd3';
import { ArrowLeft, BookOpen, ChevronRight, Loader2, Minus, Plus, RotateCcw } from 'lucide-react';
import { ChronosMascotNode } from './ChronosMascotNode';
import type { EventFrame } from './KnowledgeGraph';
import { documentLinks } from '../utils/documentLinks';
import {
  buildVersionChain,
  computeSectionDiff,
  detectDateDisorder,
  listBaselineSections,
  resolvePrevNode,
  type BaselineSection,
  type SectionChange,
  type VersionNode,
} from '../utils/documentDiff';
import {
  fetchDiffSummaryViaJob,
  fetchFileHistory,
  fetchRevisionContentsBatch,
  fetchRevisionOffice,
  type DiffResult,
  type FileHistory,
} from '../services/workspaceClient';
import DiffSummaryCard from './DiffSummaryCard';
import type { OfficeContentResponse } from '../services/apiTypes';
import type { DecisionAssertion, FileRecord, RelationEdge } from '../types/guanlan';
import { basenameOf } from '../utils/documentIdentity';
import { parseMarkdownOutline } from '../utils/guanlanEngine';
import { stageOfPath, taskPackageOf } from '../utils/taskPackages';
import { applyCanvasTheme, getCanvasTheme, subscribeCanvasTheme, type CanvasTheme } from '../utils/canvasThemeStore';
import {
  buildMarkdownHumanDiff,
  buildSvgDiff,
  buildTableDiff,
  buildXlsxDiff,
  type MdHumanDiffResult,
  type SvgDiffResult,
  type TableDiffResult,
  type XlsxDiffResult,
} from '../utils/multimodalDiff';
import { DiffSidePane } from './timemachine/DiffSidePane';
import { MdHumanDiffPanel, type MdDiffPanelMode } from './timemachine/MdHumanDiffPanel';
import { SvgComparePanel } from './timemachine/SvgComparePanel';
import { TableDiffPanel } from './timemachine/TableDiffPanel';

/**
 * vm_2/vm_3/vm_5 · 文档版本时光机（depth-1 MD 的单文档版本演化轴，方案A）。
 *
 * - 主干：fetchFileHistory → buildVersionChain，按修订链（seq 降序）自上而下 v3→v2→v1（上新下旧）；
 *   轴头强制标注『按修订链』，文档自述日期与收录顺序矛盾时强制提示，绝不悄悄改回按日期排；
 * - 内容卡：选中版本相对上一版的章节级 Diff（computeSectionDiff），未改动章节不出现；
 *   v1 初始基线展示一张章节清单汇总卡；快照淘汰版本只出元数据卡，绝不以当前磁盘内容冒充旧版；
 * - 引用分支（wf_3 横三段）：左=上游依据（出链按 taskPackageOf 分组折叠，卡面只显
 *   【任务包名+核心文档名】，展开才见完整路径）；中=版本轴 + 选中版核心结论块（💡 摘
 *   『核心结论』/首节 summaryText，置于 Diff 卡区上方）；右=下游（入链 + 同任务包资料）
 *   按任务包 id 分组折叠，组标题=包名，包内展开见核心文件名；
 * - 三重复消灭：无事件目录、无章节 Z 字卡、无原文 <pre> 粘贴；引用全屏只出现分支卡一处；
 * - 司辰：沿版本轴「点击切到下一版本」，caption 与选中高亮/Diff 卡/右栏摘要四处联动；
 * - D03 多模态扩展：SVG/CSV/TSV/XLSX 的 depth-1 下钻也进入时光机（KnowledgeGraph 路由），
 *   版本轴通用，右缘停靠「多模态对比面板」按格式分派（timemachine/ 四子组件 +
 *   utils/multimodalDiff 纯函数）：MD=人类可读视图（标题结构/决定待办/关键增删段，可切
 *   源码行 Diff）、SVG=叠影/擦除对比+改动图元框（data:URI 绝不 inline 注入）、
 *   CSV/TSV/XLSX=增删行列+单元格数值 Δ。全部有界预算，超限诚实拒绝不阻塞主线程。
 */
interface DocumentTimeMachineViewProps {
  active: boolean;
  file: FileRecord;
  frame: EventFrame;
  trail: EventFrame[];
  root: string;
  files: FileRecord[];
  relations: RelationEdge[];
  decisions: DecisionAssertion[];
  onGo: (file: FileRecord, line?: number, title?: string, revisionId?: string) => void;
  onBack: (depth: number) => void;
  onRead: (fileId: string, revisionId: string, line?: number) => void;
}

type SelectedView =
  | { state: 'pending' }
  | { state: 'unavailable' }
  | { state: 'prev-unavailable'; reason: 'evicted' | 'fetch-failed' }
  | { state: 'baseline'; sections: BaselineSection[] }
  | { state: 'diff'; changes: SectionChange[]; totalAdded: number; totalRemoved: number }
  /** D03：多模态格式（SVG/CSV/TSV/XLSX）正文就绪——章节级 MD Diff 不适用，差异见对比面板 */
  | { state: 'ready' };

/**
 * D03 · 多模态对比面板数据模型：按文件格式分派到对应人类可读视图。
 * hidden = 该选中态无可展示对比（尚未选版）；pending/unavailable/baseline 携带诚实文案。
 */
type PaneModel =
  | { kind: 'hidden' }
  | { kind: 'pending'; note: string }
  | { kind: 'unavailable'; note: string }
  | { kind: 'baseline'; note: string }
  | { kind: 'md'; result: MdHumanDiffResult }
  | { kind: 'svg'; result: SvgDiffResult; oldSvg: string; newSvg: string }
  | { kind: 'table'; result: TableDiffResult }
  | { kind: 'xlsx'; result: XlsxDiffResult };

/** 时光机状态色（v0.7 设计增补 §1.3 F 表）：值 = --cv-* 令牌字符串。
 *  暗档 = 14-hex 白名单原样（修改 #F76808 同 lane-md / 新增 #30A46C / 删除 #E5484D /
 *  SELECT #4C8DFF 同 lane-unknown / REF_OUT #26C0DB / REF_IN #8E8AE6 同 lane-svg /
 *  EVICT #F5D90A 同 lane-pdf / MUTED #9AA0A6=ink-meta / TRUNK #64646D——V7-D16 清偿
 *  （原 #232326/void 1.24 FAIL → 3.32 PASS，白名单扩档登记 V7-D15））；
 *  浅档 #C2410C/#1F7A45/#C53030/#2F5AA8/#0E7490/#5B4BC4/#8A621E/#8D8AA6 全表登记于
 *  index.css light 块（V7-D15；del ≠ --cv-unread：diff 语义 vs 未读点，浅档各自达标）。
 *  消费点硬边界：stroke=/fill= 表现属性不吃 var()，一律 style={{}} 形态（勘察 §5.2）；
 *  不采用按主题常量表路线（增补 §0.1-4：色值双源漂移 + 重渲整树）。
 *  export 供 test/canvas-theme.test.ts 值契约断言（v0.7 增补 §4-4，零视觉改动）。 */
export const KIND_COLOR: Record<SectionChange['kind'], string> = {
  修改: 'var(--cv-lane-md)',
  新增: 'var(--cv-add)',
  删除: 'var(--cv-del)',
};
export const SELECT_COLOR = 'var(--cv-lane-unknown)';
export const REF_OUT_COLOR = 'var(--cv-ref-out)';
export const REF_IN_COLOR = 'var(--cv-lane-svg)';
export const EVICT_COLOR = 'var(--cv-lane-pdf)';
export const MUTED_COLOR = 'var(--cv-ink-meta)';
export const TRUNK_COLOR = 'var(--cv-trunk)';

const TRUNK_X = 260;
const NODE_Y0 = 170;
const NODE_W = 150;
const NODE_H = 56;
const CARD_X = 352;
const CARD_W = 250;
const CARD_H = 78;
const CARD_GAP = 10;
/** wf_3 选中版核心结论块高度（渲染于 Diff 卡区上方；坐标常量不重排） */
const CONC_H = 76;
const REF_X = 30;
const REF_W = 146;
const REF_H = 64;
const REF_GAP = 58;
const REF_TITLE_Y = 330;
const REF_Y0 = 344;

// ---- TL-02：版本轴几何可推导参数（导出供几何单测复用） ----
/** 画布 viewBox 高（与 <svg viewBox="0 0 794 640"> :312 保持一致） */
export const MACHINE_VIEW_H = 640;
/** 尾节点 trunk 收束帽高度（trunkEnd = nodeY(len-1) + 26） */
const TRUNK_END_MARGIN = 26;
/** 底部安全留白：保证 trunkEnd 收敛点不贴死 viewBox 下沿 */
const MACHINE_BOTTOM_PAD = 18;

/**
 * 版本轴节点纵向间距（确定性、保证不溢出）：
 * 短链沿用原 96；一旦轴向可用高度装不下，就按「可用高度 / (len-1)」全局收束，
 * 确保任意链长下 trunkEnd ≤ MACHINE_VIEW_H。旧实现在 len=6 时（96）trunkEnd=676、
 * len=8 时（64）trunkEnd=644，均已冲出 640 高度溢出截断——此函数根治该缺陷。
 * 可用 trunk 高度 = 视图高 − 顶部 NODE_Y0 − 尾帽 26 − 底部留白 18。
 */
export function timeMachineSpacing(chainLen: number): number {
  if (chainLen <= 1) return 96;
  const usable = MACHINE_VIEW_H - NODE_Y0 - TRUNK_END_MARGIN - MACHINE_BOTTOM_PAD;
  const maxFit = Math.floor(usable / (chainLen - 1));
  // 底限 1：仅作除零/退化保护，绝不上抬 spacing 以致 trunkEnd 超出 viewBox。
  // 任何 n>1 都返回 ≤ maxFit，故 trunkEnd = NODE_Y0 + spacing*(n-1) + 26 ≤ viewBox 恒成立。
  return Math.max(1, Math.min(96, maxFit));
}
/** 第 index 个版本节点中心 Y（自上而下 v_new→v_old，上新下旧方向不变） */
export function timeMachineNodeY(index: number, chainLen: number): number {
  return NODE_Y0 + index * timeMachineSpacing(chainLen);
}
/** 主干收束端 Y；空链回落到 NODE_Y0+26 附近（原 336） */
export function timeMachineTrunkEnd(chainLen: number): number {
  return chainLen ? timeMachineNodeY(chainLen - 1, chainLen) + TRUNK_END_MARGIN : 336;
}

// ---- U04 · 版本时光机「司辰琉璃化」纯函数（无 DOM 依赖；单测直引，禁把坐标计算堆进组件） ----

/** 主干贝塞尔上端点纵坐标（与 <path d="M 260 100 Q 252 200 260 end"> 逐字同源） */
const TRUNK_TOP_Y = 100;
/** 主干贝塞尔控制点纵坐标（同上） */
const TRUNK_CTRL_Y = 200;

/**
 * 主干二次贝塞尔在给定 y 处的精确落点（纯几何）。
 * 主干 path 与本函数同源（M 260 100 / Q 252 200 / 260 trunkEnd）：引线自脊柱「长出来」，
 * 不再从 x=260 硬接（控制点把曲线中段拉向 252，硬接会浮空最多 8px）。
 * y(t) 在 trunkEnd ≥ 200 时单调递增 → 二分 40 轮收敛（纯函数，可单测）。
 */
export function timeMachineTrunkPointAtY(targetY: number, trunkEnd: number): { x: number; y: number } {
  const endY = Number.isFinite(trunkEnd) ? trunkEnd : TRUNK_TOP_Y;
  const want = Number.isFinite(targetY) ? Math.max(TRUNK_TOP_Y, Math.min(endY, targetY)) : TRUNK_TOP_Y;
  const yOf = (t: number) =>
    (1 - t) * (1 - t) * TRUNK_TOP_Y + 2 * (1 - t) * t * TRUNK_CTRL_Y + t * t * endY;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 40; i += 1) {
    const mid = (lo + hi) / 2;
    if (yOf(mid) < want) lo = mid;
    else hi = mid;
  }
  const t = (lo + hi) / 2;
  const x = (1 - t) * (1 - t) * TRUNK_X + 2 * (1 - t) * t * (TRUNK_X - 8) + t * t * TRUNK_X;
  return { x, y: want };
}

/**
 * 版本增量条几何：新增/删除两段比例（0-100）+ 紧凑文案。
 * 诚实边界：无真实 +/- 行数时 hasData=false、label 空串——卡面留空槽，绝不伪造比例。
 */
export interface VersionDeltaBar {
  added: number;
  removed: number;
  total: number;
  /** 新增段宽度百分比 */
  addedPct: number;
  /** 删除段宽度百分比（与新增段合计 100） */
  removedPct: number;
  /** 是否有真实行数可展示 */
  hasData: boolean;
  /** 紧凑文案 '+12/-3'（无数据时为空串） */
  label: string;
}

export function computeVersionDeltaBar(added: number, removed: number): VersionDeltaBar {
  // 非有限数＝取不到真实行数 → 整条留空（比例无从谈起，绝不按残缺数据编比例）
  if (!Number.isFinite(added) || !Number.isFinite(removed)) {
    return { added: 0, removed: 0, total: 0, addedPct: 0, removedPct: 0, hasData: false, label: '' };
  }
  // 负数钳 0（负行数是脏数据：按「无此方向变更」处理，另一方向仍按真值呈现）
  const a = added > 0 ? Math.floor(added) : 0;
  const r = removed > 0 ? Math.floor(removed) : 0;
  const total = a + r;
  if (total <= 0) {
    return { added: a, removed: r, total: 0, addedPct: 0, removedPct: 0, hasData: false, label: '' };
  }
  const addedPct = Math.round((a / total) * 100);
  return {
    added: a,
    removed: r,
    total,
    addedPct,
    removedPct: 100 - addedPct,
    hasData: true,
    label: `+${a}/-${r}`,
  };
}

// ---- U04 · 浮层遮挡避让（Diff 面板压住版本轴）纯函数 ----

/** 画布 viewBox 宽（与 <svg viewBox="0 0 794 640"> 同源） */
export const MACHINE_VIEW_W = 794;
/**
 * 右侧 Diff 面板占画布宽的比例（与 DiffSidePane 的 width:min(560px,62%) 同源）。
 * 窄屏被 560px 夹住时面板更窄 → 留给画布的更宽，故 62% 是最坏值。
 */
export const DIFF_PANE_VIEW_SHARE = 0.62;
/** Diff 面板左缘（viewBox 单位）：画布右侧 62% 被面板覆盖 */
export const DIFF_PANE_LEFT_EDGE = MACHINE_VIEW_W * (1 - DIFF_PANE_VIEW_SHARE);

/**
 * 浮层遮挡避让量（viewBox 单位）：面板打开时，卡面右缘若越过面板左缘，
 * 就把越界量（含 3 单位呼吸）让出来——否则卡内文字被浮层硬切（无省略号兜底）、
 * 「当前/初始基线」角标与底部比例条右端被吞（门禁按 scrollWidth 口径判不出此类问题）。
 * 面板收起时恒 0（卡面完整，不留空）。
 */
export function machinePaneReserve(rightEdge: number, paneOpen: boolean): number {
  if (!paneOpen || !Number.isFinite(rightEdge)) return 0;
  return Math.max(0, Math.ceil(rightEdge - DIFF_PANE_LEFT_EDGE + 3));
}

/**
 * 版本节点相对时间：与卡面绝对戳同锚点（occurred_at ?? observed_at，只换叙述形态，绝不换口径）。
 * 仅日期锚点按本地日历日解析（new Date('YYYY-MM-DD') 走 UTC 零点，负时区会串到前一天）；
 * 超过 30 天回落绝对戳（老版本不写「N 天前」的假近感）。
 */
export function versionRelativeLabel(anchorAt: string, nowMs: number): string {
  if (!anchorAt) return '';
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(anchorAt);
  let parsed: Date;
  if (dateOnly) {
    const [year, month, day] = anchorAt.split('-').map(Number);
    parsed = new Date(year ?? 1970, (month ?? 1) - 1, day ?? 1);
  } else {
    parsed = new Date(anchorAt);
  }
  if (Number.isNaN(parsed.getTime())) return '';
  const now = new Date(Number.isFinite(nowMs) ? nowMs : Date.now());
  const pad2 = (value: number) => String(value).padStart(2, '0');
  const dayMs = 86_400_000;
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const dayDiff = Math.round((startOfDay(now) - startOfDay(parsed)) / dayMs);
  const hhmm = `${pad2(parsed.getHours())}:${pad2(parsed.getMinutes())}`;
  const md = `${pad2(parsed.getMonth() + 1)}-${pad2(parsed.getDate())}`;
  if (dayDiff === 0) {
    if (dateOnly) return '今天';
    const minutes = Math.floor((now.getTime() - parsed.getTime()) / 60000);
    if (minutes <= 0) return '刚刚';
    if (minutes < 60) return `${minutes}分钟前`;
    if (minutes < 24 * 60) return `${Math.floor(minutes / 60)}小时前`;
    return `今天 ${hhmm}`;
  }
  if (dayDiff === 1) return dateOnly ? '昨天' : `昨天 ${hhmm}`;
  if (dayDiff > 1 && dayDiff <= 30) return `${dayDiff} 天前`;
  if (parsed.getFullYear() === now.getFullYear()) return dateOnly ? md : `${md} ${hhmm}`;
  const ymd = `${parsed.getFullYear()}-${md}`;
  return dateOnly ? ymd : `${ymd} ${hhmm}`;
}

/** 司辰基准纵坐标（与既有 <g transform="translate(55 140)"> 同值） */
export const CHRONOS_BASE_Y = 140;
/** 司辰跟随阻尼系数：位移按比例收敛，长链时不甩出视口 */
export const CHRONOS_FOLLOW_DAMPING = 0.28;
/** 司辰跟随硬上限：左栏上游依据卡自 REF_Y0(344) 起，司辰底缘不得越界压盖 */
export const CHRONOS_FOLLOW_MAX = 48;

/**
 * 司辰跟随偏移：随当前选中版本的纵向位置阻尼位移（≤ CHRONOS_FOLLOW_MAX）。
 * 纯函数：单测断言「越界取上限 / 非法输入回落 0 / 单调不减」。
 */
export function chronosFollowOffsetY(selectedY: number): number {
  if (!Number.isFinite(selectedY)) return 0;
  const raw = (selectedY - NODE_Y0) * CHRONOS_FOLLOW_DAMPING;
  return Math.max(0, Math.min(CHRONOS_FOLLOW_MAX, raw));
}

// ---- TA-01：版本轴排序口径角标（导出为纯函数，不依赖 DOM 渲染即可断言） ----
export const VERSION_AXIS_BADGE = '按修订链';
export const VERSION_DATE_DISORDER_NOTICE = '文档自述日期与收录顺序不一致';

/**
 * 版本轴标题区文案：固定『按修订链』（主序 = seq / capture 顺序）；
 * 文档自述日期与收录顺序矛盾时追加强制提示——绝不悄悄改回按日期排。
 */
export function versionAxisNotice(chain: VersionNode[]): { badge: string; notice: string | null } {
  return {
    badge: VERSION_AXIS_BADGE,
    notice: detectDateDisorder(chain) ? VERSION_DATE_DISORDER_NOTICE : null,
  };
}

/**
 * wf_3 选中版核心结论摘取：对版本快照 markdown 调 parseMarkdownOutline，
 * 与 extractCoreSummary 同式——isExplicitCallout==='核心结论' 章节的 summaryText 优先，
 * 缺失回退首节 summaryText；无任何章节返回 ''。导出供结论块渲染与断言复用。
 */
export function coreConclusionOfMarkdown(markdown: string): string {
  const sections = parseMarkdownOutline(markdown);
  const coreSec = sections.find((s) => s.isExplicitCallout === '核心结论') || sections[0];
  return coreSec?.summaryText ?? '';
}

/**
 * U04 · 画布主题分段钮（纸面 / 夜航）——叶子自订阅 canvasThemeStore。
 * 主题值不入 React state（v0.7 §1.1 双主题活值层纪律）：一次翻转只重渲本叶子，
 * 舷窗 data-canvas-theme / theme-morphing 由宿主命令式直写 DOM（见 handleMachineThemeChange）。
 */
export function MachineThemeSegmented({ onChange }: { onChange: (next: CanvasTheme) => void }) {
  // getServerSnapshot 同源（node/SSR 无 window 时 store 守卫回默认夜航）——
  // 缺省会触发 React「Missing getServerSnapshot」告警（Console 0 Warning 红线）。
  const theme = useSyncExternalStore(subscribeCanvasTheme, getCanvasTheme, getCanvasTheme);
  return (
    <div
      role="group"
      aria-label="画布主题"
      data-slot="segmented-control"
      className="machine-theme-seg"
      data-machine-theme-seg=""
    >
      {(
        [
          { key: 'xray-dark', label: '夜航' },
          { key: 'xray-light', label: '纸面' },
        ] as const
      ).map((seg) => (
        <button
          key={seg.key}
          type="button"
          aria-pressed={theme === seg.key}
          aria-label={seg.key === 'xray-light' ? '切换画布为纸面主题' : '切换画布为夜航主题'}
          className="machine-theme-seg-btn"
          onClick={() => onChange(seg.key)}
        >
          {seg.label}
        </button>
      ))}
    </div>
  );
}

export function DocumentTimeMachineView({
  active, file, frame, trail, root, files, relations, decisions, onGo, onBack, onRead,
}: DocumentTimeMachineViewProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const worldRef = useRef<SVGGElement>(null);
  const zoomRef = useRef<d3.ZoomBehavior<SVGSVGElement, unknown> | null>(null);
  // U04 · 舷窗宿主锚：时光机整体渲染在 .dark-porthole 内（KnowledgeGraph 常驻舷窗），
  // 主题翻转据此命令式直写舷窗 DOM（与宿主 handleCanvasThemeChange 同款语义）。
  const hostRef = useRef<HTMLElement>(null);
  const [scale, setScale] = useState(1);
  const [positions, setPositions] = useState<Record<string, { x: number; y: number }>>({});
  const [hover, setHover] = useState(false);
  const position = (key: string, x: number, y: number) => positions[key] ?? { x, y };

  /**
   * U04 · 画布主题翻转（纸面 / 夜航）：与宿主 useWorkspaceStore.handleCanvasThemeChange
   * 同款语义——命令式直写舷窗 DOM（theme-morphing 摘挂与 dataset 翻转落同一同步任务，
   * 浏览器不为整子树作废样式），再 applyCanvasTheme 更新活值 + 本机持久化 + 通知订阅叶子。
   * 主题值不进 React state（v0.7 §1.1 双主题活值层纪律）。
   */
  const handleMachineThemeChange = (next: CanvasTheme) => {
    if (next === getCanvasTheme()) return;
    const porthole = hostRef.current?.closest('.dark-porthole') as HTMLElement | null;
    if (porthole) {
      porthole.classList.remove('theme-morphing');
      porthole.classList.add('theme-morphing');
      porthole.dataset.canvasTheme = next;
    }
    applyCanvasTheme(next);
  };

  // ---- D03 多模态 Diff：格式分派（md 走既有章节级 Diff；svg/表格/工作簿走对比面板）----
  const isMd = file.format === 'md';
  const isSvg = file.format === 'svg';
  const isXlsx = file.format === 'xlsx';
  const isTable = file.format === 'csv' || file.format === 'tsv';
  const isMultimodal = isSvg || isTable || isXlsx;

  const [history, setHistory] = useState<FileHistory | null>(null);
  const [loading, setLoading] = useState(false);
  const [historyError, setHistoryError] = useState('');
  const [historyNonce, setHistoryNonce] = useState(0);
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined);
  const [contents, setContents] = useState<Record<string, string>>({});
  const [fetchFailed, setFetchFailed] = useState<Record<string, boolean>>({});
  // D03：XLSX 走 B03 office 端点（结构化 rows），不走正文文本通道（二进制无内联 text）
  const [officeByRev, setOfficeByRev] = useState<Record<string, OfficeContentResponse>>({});
  const [officeFailed, setOfficeFailed] = useState<Record<string, boolean>>({});
  // D03 对比面板：受控开合（数据到位自动展开；收起后右缘把手可重开）
  const [paneOpen, setPaneOpen] = useState(false);
  const [mdPaneMode, setMdPaneMode] = useState<MdDiffPanelMode>('human');
  // wf_3 左栏上游依据折叠态：taskPackage id → 是否展开（展开态成员卡 title 才透出完整路径）
  const [expandedRefs, setExpandedRefs] = useState<Record<string, boolean>>({});
  // wf_3 右栏下游分组折叠态（用户手改后持久；未记录时按「所属任务包 + 篇数 ≤6」默认展开）
  const [openDownstream, setOpenDownstream] = useState<Record<string, boolean>>({});

  // 版本链按需读取：失败显示『读取文件历史失败』+ 重试
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    setLoading(true);
    setHistoryError('');
    setHistory(null);
    void fetchFileHistory(file.file_id).then((result) => {
      if (cancelled) return;
      setLoading(false);
      if (!result) {
        setHistoryError('读取文件历史失败（/history 无响应或返回错误）');
        return;
      }
      setHistory(result);
    });
    return () => {
      cancelled = true;
    };
  }, [active, file.file_id, historyNonce]);

  const chain = useMemo<VersionNode[]>(() => (history ? buildVersionChain(history) : []), [history]);
  // TA-01：版本轴口径角标（固定『按修订链』；日期与收录顺序矛盾时强制提示）
  const axisNotice = versionAxisNotice(chain);
  // 相对时间基准（同一渲染批次内固定，避免同帧标签漂移）
  const nowMs = useMemo(() => Date.now(), [chain, selectedId]);

  // 默认选中：frame.revisionId 在链中则选它（搜索命中下钻带 revisionId），否则选最新版本（轴顶）
  useEffect(() => {
    if (!chain.length) return;
    if (selectedId && chain.some((node) => node.revisionId === selectedId)) return;
    const wanted = chain.some((node) => node.revisionId === frame.revisionId) ? frame.revisionId : chain[0].revisionId;
    setSelectedId(wanted);
  }, [chain, frame.revisionId, selectedId]);

  const selectedNode = chain.find((node) => node.revisionId === selectedId) ?? null;
  // TA-01：父版按修订链解析（prev_revision_id 命中；悬空时回退 seq 前驱），
  // 不再取时间相邻节点，避免 Diff 对比错版、避免父版悬空时误判『初始基线』
  const prevNode = useMemo(
    () => resolvePrevNode(chain, selectedNode),
    [chain, selectedNode],
  );

  // 语义 Diff 摘要卡（PRD 3.5 / 方案 F7）：星图下钻的版本行动作——选中版与其父版
  // 走任务队列口径摘要（POST /diff 202 → result）。端点未落地时如实提示，
  // 本地 computeSectionDiff 章节对比不受影响
  const [semanticDiff, setSemanticDiff] = useState<{
    loading: boolean;
    result: DiffResult | null;
    error: string | null;
    label: string;
  } | null>(null);
  const requestSemanticDiff = (node: VersionNode, prev: VersionNode | null) => {
    if (!prev) return;
    setSemanticDiff({
      loading: true,
      result: null,
      error: null,
      label: `${prev.label} → ${node.label}`,
    });
    void fetchDiffSummaryViaJob({
      file_id: file.file_id,
      baseline_revision_id: prev.revisionId,
      target_revision_id: node.revisionId,
    }).then((res) => {
      setSemanticDiff((prevState) =>
        prevState && prevState.label === `${prev.label} → ${node.label}`
          ? res.ok
            ? { ...prevState, loading: false, result: res.data, error: null }
            : { ...prevState, loading: false, result: null, error: res.error || '任务队列不可用' }
          : prevState
      );
    });
  };

  // 正文按需拉取：仅 snapshot_available 且无缓存的版本发起（镜像 ReaderView diffContents/diffFetchFailed 模式）；
  // XLSX 为二进制（content 端点无内联 text），正文通道对 xlsx 关闭，office 结构化数据另走下方 effect
  const neededIds = useMemo(() => {
    if (!selectedNode || !selectedNode.snapshotAvailable || isXlsx) return [];
    const ids = [selectedNode.revisionId];
    if (selectedNode.prevRevisionId && prevNode?.snapshotAvailable) ids.push(prevNode.revisionId);
    return ids;
  }, [selectedNode, prevNode, isXlsx]);
  // D03：XLSX 两版 office 结构化载荷按需拉取（status!==indexed 诚实标记失败，不伪造结构）
  useEffect(() => {
    if (!active || !isXlsx) return;
    const ids: string[] = [];
    if (selectedNode?.snapshotAvailable &&
      officeByRev[selectedNode.revisionId] === undefined && !officeFailed[selectedNode.revisionId]) {
      ids.push(selectedNode.revisionId);
    }
    if (prevNode?.snapshotAvailable &&
      officeByRev[prevNode.revisionId] === undefined && !officeFailed[prevNode.revisionId]) {
      ids.push(prevNode.revisionId);
    }
    if (!ids.length) return;
    let cancelled = false;
    void Promise.all(ids.map(async (id) => ({ id, res: await fetchRevisionOffice(id) }))).then((pairs) => {
      if (cancelled) return;
      setOfficeByRev((prev) => {
        const next = { ...prev };
        for (const { id, res } of pairs) if (res.ok) next[id] = res.data;
        return next;
      });
      setOfficeFailed((prev) => {
        const next = { ...prev };
        for (const { id, res } of pairs) if (!res.ok) next[id] = true;
        return next;
      });
    });
    return () => {
      cancelled = true;
    };
  }, [active, isXlsx, selectedNode, prevNode, officeByRev, officeFailed]);
  useEffect(() => {
    if (!active) return;
    const missing = neededIds.filter((id) => contents[id] === undefined && !fetchFailed[id]);
    if (!missing.length) return;
    let cancelled = false;
    void fetchRevisionContentsBatch(missing, contents).then(({ contents: fetched, failed }) => {
      if (cancelled) return;
      if (Object.keys(fetched).length > 0) setContents((prev) => ({ ...prev, ...fetched }));
      if (Object.keys(failed).length > 0) {
        setFetchFailed((prev) => ({
          ...prev,
          ...Object.fromEntries(Object.keys(failed).map((id) => [id, true])),
        }));
      }
    });
    return () => {
      cancelled = true;
    };
  }, [active, neededIds, contents, fetchFailed]);

  const selContent = selectedNode?.snapshotAvailable ? contents[selectedNode.revisionId] : undefined;
  const selFailed = selectedNode ? fetchFailed[selectedNode.revisionId] === true : false;
  const prevContent = prevNode?.snapshotAvailable ? contents[prevNode.revisionId] : undefined;
  const prevFailed = prevNode ? fetchFailed[prevNode.revisionId] === true : false;

  const selView = useMemo<SelectedView>(() => {
    if (!selectedNode) return { state: 'pending' };
    // D03：多模态格式不走章节级 MD Diff——选中版可用即 ready（差异组装在 paneModel）
    if (isMultimodal) {
      if (!selectedNode.snapshotAvailable) return { state: 'unavailable' };
      if (isXlsx) return officeFailed[selectedNode.revisionId] ? { state: 'unavailable' } : { state: 'ready' };
      if (selFailed) return { state: 'unavailable' };
      return selContent === undefined ? { state: 'pending' } : { state: 'ready' };
    }
    if (!selectedNode.snapshotAvailable || selFailed || selContent === undefined) {
      if (selectedNode.snapshotAvailable && !selFailed && selContent === undefined) return { state: 'pending' };
      return { state: 'unavailable' };
    }
    if (!prevNode) return { state: 'baseline', sections: listBaselineSections(selContent) };
    if (!prevNode.snapshotAvailable) return { state: 'prev-unavailable', reason: 'evicted' };
    if (prevContent === undefined) {
      return prevFailed ? { state: 'prev-unavailable', reason: 'fetch-failed' } : { state: 'pending' };
    }
    const changes = computeSectionDiff(prevContent, selContent);
    return {
      state: 'diff',
      changes,
      totalAdded: changes.reduce((sum, change) => sum + change.added, 0),
      totalRemoved: changes.reduce((sum, change) => sum + change.removed, 0),
    };
  }, [selectedNode, prevNode, selContent, selFailed, prevContent, prevFailed, isMultimodal, isXlsx, officeFailed]);

  // ---- U04 · 版本增量口径（单一事实源）----
  // 版本节点卡的 +/- 行数必须与右侧 Diff 面板 / 检查器「相对上一版」同口径（章节级
  // computeSectionDiff 统计）——历史事件 payload 的 added_lines 是另一套口径，两套数字
  // 同屏出现且未标注来源即构成误导（任务卡停机条件：诚实边界）。
  // 故：只认章节级 diff 统计；选中版实时取、已访问版缓存（切版后仍留痕）。
  const [chapterDeltaByRev, setChapterDeltaByRev] = useState<Record<string, { added: number; removed: number }>>({});
  useEffect(() => {
    if (!selectedNode || selView.state !== 'diff') return;
    const added = selView.totalAdded;
    const removed = selView.totalRemoved;
    setChapterDeltaByRev((prev) => {
      const cur = prev[selectedNode.revisionId];
      if (cur && cur.added === added && cur.removed === removed) return prev;
      return { ...prev, [selectedNode.revisionId]: { added, removed } };
    });
  }, [selectedNode, selView]);
  /** 某版本的章节级增量统计（无章节级 diff 真相时 undefined → 卡面留空槽，绝不伪造） */
  const chapterDeltaOf = (revisionId: string): { added: number; removed: number } | undefined => {
    if (selectedNode && revisionId === selectedNode.revisionId && selView.state === 'diff') {
      return { added: selView.totalAdded, removed: selView.totalRemoved };
    }
    return chapterDeltaByRev[revisionId];
  };

  // ---- D03：多模态对比面板数据派发（全部纯函数、有界预算内，<100ms 停机口径）----
  const paneModel = useMemo<PaneModel>(() => {
    if (!selectedNode) return { kind: 'hidden' };
    if (isMd) {
      if (selView.state === 'baseline') return { kind: 'baseline', note: `初始基线 · ${selView.sections.length} 个章节（无上一版可对比）` };
      if (selView.state === 'unavailable') return { kind: 'unavailable', note: '与上一版差异不可用（快照已淘汰）——绝不以当前文件冒充历史版本。' };
      if (selView.state === 'prev-unavailable') {
        return { kind: 'unavailable', note: selView.reason === 'evicted' ? '上一版快照已淘汰，对比基线不可用。' : '上一版正文读取失败，暂不可对比。' };
      }
      if (selView.state === 'pending') return { kind: 'pending', note: '正在读取版本正文…' };
      if (selView.state !== 'diff' || selContent === undefined || prevContent === undefined) return { kind: 'hidden' };
      return { kind: 'md', result: buildMarkdownHumanDiff(prevContent, selContent) };
    }
    if (isSvg || isTable) {
      if (selView.state === 'unavailable') return { kind: 'unavailable', note: '快照已淘汰，仅保留版本元数据——绝不以当前文件冒充历史版本。' };
      if (selView.state === 'pending') return { kind: 'pending', note: '正在读取版本正文…' };
      if (selContent === undefined) return { kind: 'hidden' };
      if (!prevNode) return { kind: 'baseline', note: `初始基线 · ${(isSvg ? '图元' : '数据行')}结构将作为后续版本对比基线` };
      if (!prevNode.snapshotAvailable) return { kind: 'unavailable', note: '上一版快照已淘汰，对比基线不可用。' };
      if (prevFailed) return { kind: 'unavailable', note: '上一版正文读取失败，暂不可对比。' };
      if (prevContent === undefined) return { kind: 'pending', note: '正在读取上一版正文…' };
      return isSvg
        ? { kind: 'svg', result: buildSvgDiff(prevContent, selContent), oldSvg: prevContent, newSvg: selContent }
        : { kind: 'table', result: buildTableDiff(prevContent, selContent, file.format === 'tsv' ? '\t' : ',') };
    }
    if (isXlsx) {
      const cur = officeByRev[selectedNode.revisionId];
      if (!selectedNode.snapshotAvailable || officeFailed[selectedNode.revisionId]) {
        return { kind: 'unavailable', note: '工作簿快照不可用（已淘汰或读取失败）——绝不以当前文件冒充历史版本。' };
      }
      if (!cur) return { kind: 'pending', note: '正在读取工作簿结构…' };
      if (cur.status !== 'indexed' || !cur.xlsx) {
        return { kind: 'unavailable', note: `工作簿结构化数据不可用（${cur.status}${cur.error_reason ? '：' + cur.error_reason : ''}）。` };
      }
      if (!prevNode) return { kind: 'baseline', note: `初始基线 · ${cur.xlsx.total_sheets} 个工作表将作为后续版本对比基线` };
      if (!prevNode.snapshotAvailable || officeFailed[prevNode.revisionId]) {
        return { kind: 'unavailable', note: '上一版快照已淘汰或读取失败，对比基线不可用。' };
      }
      const prev = officeByRev[prevNode.revisionId];
      if (!prev) return { kind: 'pending', note: '正在读取上一版工作簿结构…' };
      if (prev.status !== 'indexed' || !prev.xlsx) {
        return { kind: 'unavailable', note: `上一版工作簿结构化数据不可用（${prev.status}${prev.error_reason ? '：' + prev.error_reason : ''}）。` };
      }
      return { kind: 'xlsx', result: buildXlsxDiff(prev.xlsx, cur.xlsx) };
    }
    return { kind: 'hidden' };
  }, [selectedNode, prevNode, selView, selContent, prevContent, prevFailed, isMd, isSvg, isTable, isXlsx, file.format, officeByRev]);

  // 数据到位/切版本自动展开对比面板；用户收起后经右缘把手重开（受控，不劫持）
  const paneSignature = `${selectedId ?? ''}|${paneModel.kind}`;
  useEffect(() => {
    if (paneModel.kind !== 'hidden') setPaneOpen(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 以签名（选中版+面板态）驱动，避免每渲染重开
  }, [paneSignature]);

  // ---- 引用分支（契约C）：出链解析选中版快照正文（Markdown 专属口径，非 md 走结构化 relations 边）----
  const byId = useMemo(() => new Map(files.map((item) => [item.file_id, item])), [files]);
  const readLinks = useMemo(() => documentLinks(files, root), [files, root]);
  const outbound = useMemo<RelationEdge[] | null>(() => {
    if (isMd && selContent !== undefined) return readLinks(file, selContent);
    const evicted = !selectedNode || !selectedNode.snapshotAvailable || (isMd && selFailed);
    if (evicted) return relations.filter((edge) => edge.source_id === file.file_id && !edge.isInferred);
    return isMd && selContent === undefined ? null : relations.filter((edge) => edge.source_id === file.file_id && !edge.isInferred);
  }, [isMd, selContent, selectedNode, selFailed, readLinks, file, relations]);
  const inbound = useMemo(
    () => relations.filter((edge) => edge.target_id === file.file_id && !edge.isInferred),
    [relations, file.file_id],
  );
  // wf_3 左=上游依据：出链按 taskPackageOf(target).id 分组折叠（组内保留边序）
  const outGroups = useMemo<{ pkgId: string; pkgName: string; edges: RelationEdge[] }[] | null>(() => {
    if (!outbound) return null;
    const groups = new Map<string, { pkgId: string; pkgName: string; edges: RelationEdge[] }>();
    for (const edge of outbound) {
      const other = byId.get(edge.target_id);
      if (!other) continue; // 与既有 renderRefCard 同语义：目标缺失不渲染
      const pkg = taskPackageOf(other.relative_path);
      const g = groups.get(pkg.id);
      if (g) g.edges.push(edge);
      else groups.set(pkg.id, { pkgId: pkg.id, pkgName: pkg.name, edges: [edge] });
    }
    return [...groups.values()].sort((a, b) => (a.pkgId < b.pkgId ? -1 : a.pkgId > b.pkgId ? 1 : 0));
  }, [outbound, byId]);

  // 所属任务包（DoD3：任何页面一眼看到所属专项任务）
  const myPkg = useMemo(() => taskPackageOf(file.relative_path), [file.relative_path]);

  // wf_3 右=下游：被引用（入链 source）+ 同任务包资料，按 taskPackageOf id 分组折叠；
  // 组内按阅读顺序（阶段序 蓝图→计划→决策→执行→交付→待分类，阶段内 basename 自然序）
  const downstreamGroups = useMemo(() => {
    const groups = new Map<string, { pkgId: string; pkgName: string; items: { file: FileRecord; referenced: boolean }[] }>();
    const push = (f: FileRecord, referenced: boolean) => {
      if (f.file_id === file.file_id) return;
      const pkg = taskPackageOf(f.relative_path);
      const g = groups.get(pkg.id);
      if (g) {
        if (!g.items.some((it) => it.file.file_id === f.file_id)) g.items.push({ file: f, referenced });
      } else {
        groups.set(pkg.id, { pkgId: pkg.id, pkgName: pkg.name, items: [{ file: f, referenced }] });
      }
    };
    for (const edge of inbound) {
      const src = byId.get(edge.source_id);
      if (src) push(src, true);
    }
    for (const f of files) {
      if (f.file_id !== file.file_id && taskPackageOf(f.relative_path).id === myPkg.id) push(f, false);
    }
    const rank: Record<string, number> = { 蓝图: 0, 计划: 1, 决策: 2, 执行: 3, 交付: 4, 待分类: 5 };
    for (const g of groups.values()) {
      g.items.sort((a, b) => {
        const ra = rank[stageOfPath(a.file.relative_path)] ?? 5;
        const rb = rank[stageOfPath(b.file.relative_path)] ?? 5;
        if (ra !== rb) return ra - rb;
        return basenameOf(a.file.relative_path).localeCompare(basenameOf(b.file.relative_path), undefined, { numeric: true });
      });
    }
    return [...groups.values()].sort((a, b) => (a.pkgId < b.pkgId ? -1 : a.pkgId > b.pkgId ? 1 : 0));
  }, [inbound, byId, files, file.file_id, myPkg.id]);
  const fileDecisions = useMemo(
    () => decisions.filter((d) => d.evidences.some((e) => e.file_id === file.file_id && e.revision_id === frame.revisionId)),
    [decisions, file.file_id, frame.revisionId],
  );

  const openOriginal = (line?: number) => onRead(file.file_id, selectedId ?? frame.revisionId, line);
  const goLink = (fileId: string) => {
    const target = byId.get(fileId);
    if (target) onGo(target);
  };

  // ---- 司辰（契约E）：点击沿版本轴自上而下推进一格，v1 后循环回轴顶 ----
  const cycleToNext = () => {
    if (!chain.length) return;
    const index = chain.findIndex((node) => node.revisionId === selectedId);
    const next = chain[(index + 1) % chain.length] ?? chain[0];
    setSelectedId(next.revisionId);
  };
  // U04 · 司辰 caption 动态播报当版演化摘要：版本号 + 章节级真实 +/- 行数（与面板/检查器同口径）
  const selectedDeltaStat = selectedNode ? chapterDeltaOf(selectedNode.revisionId) : undefined;
  const selectedDelta = selectedDeltaStat
    ? computeVersionDeltaBar(selectedDeltaStat.added, selectedDeltaStat.removed)
    : null;
  const deltaTag = selectedDelta?.hasData ? ` · ${selectedDelta.label}` : '';
  const mascotCaption = !selectedNode ? '版本时光机'
    : selView.state === 'unavailable' || selView.state === 'prev-unavailable' ? '差异不可用'
    : selView.state === 'pending' ? '读取差异中…'
    : selView.state === 'baseline' ? `初始基线 · ${isMd ? selView.sections.length + ' 个章节' : '暂无上一版可对比'}`
    : selView.state === 'ready' ? multimodalCaption(paneModel, selectedNode.seq)
    : isMd ? `v${selectedNode.seq}${deltaTag} · ${selView.changes.length} 章变更`
    : `v${selectedNode.seq}${deltaTag} · 差异就绪`;

  // ---- 画布几何与交互（复刻 EventTimelineCanvas 模式：zoom/drag/curve/foreignObject）----
  // TL-02：spacing/nodeY/trunkEnd 收束为可推导函数，保证任意链长 trunkEnd ≤ 640 不溢出
  const nodeY = (index: number) => timeMachineNodeY(index, chain.length);
  const trunkEnd = timeMachineTrunkEnd(chain.length);
  // 主干 path（几何逐字沿用旧实现：M 260 100 Q 252 200 260 trunkEnd；tl02 保绿）
  const trunkPath = `M ${TRUNK_X} ${TRUNK_TOP_Y} Q ${TRUNK_X - 8} ${TRUNK_CTRL_Y} ${TRUNK_X} ${trunkEnd}`;
  const selIndex = selectedNode ? chain.findIndex((node) => node.revisionId === selectedNode.revisionId) : -1;
  const selY = selIndex >= 0 ? nodeY(selIndex) : NODE_Y0;
  // U04 · 司辰随当前选中版本阻尼跟随（transform 过渡；不动版本节点本身——数据区禁飞）
  const chronosOffset = chronosFollowOffsetY(selY);
  // wf_3 左栏槽位分配：每组占 1 槽，展开组追加成员数槽位（复用 REF_Y0/REF_GAP，坐标系不重排）
  const refSlotStart: number[] = [];
  {
    let slot = 0;
    for (const g of outGroups ?? []) {
      refSlotStart.push(slot);
      slot += 1 + (expandedRefs[g.pkgId] ? g.edges.length : 0);
    }
  }
  // U04 · 引线自主干贝塞尔上的精确落点起笔（不再从 x=260 硬接，脊柱中段被控制点拉向 252）
  const curve = (y1: number, x2: number, y2: number) => {
    const start = timeMachineTrunkPointAtY(y1, trunkEnd);
    return `M ${start.x} ${start.y} C ${TRUNK_X + (x2 - TRUNK_X) * .48} ${y1}, ${x2 - (x2 - TRUNK_X) * .3} ${y2}, ${x2} ${y2}`;
  };
  // U04 · 浮层遮挡避让：Diff 面板展开时，轴列卡面（版本卡 / hub 卡）整体收窄到
  // 面板左缘之前（面板左缘在 viewBox 单位 = 画布右侧 62%），让出量含 3 单位呼吸。
  // 不避让的后果：卡面右 22% 被浮层压住——「当前/初始基线」角标 100% 不可见、
  // 卡内文字被浮层硬切（无省略号兜底）、底部增删比例条右端被切；
  // 门禁按 scrollWidth 口径判不出此类 overlay 遮挡，只能靠几何避让根治。
  // 收窄的是「渲染宽度」（foreignObject 宽），NODE_W/NODE_H 等几何常量一字未改。
  const nodeReserve = machinePaneReserve(TRUNK_X + NODE_W / 2, paneOpen);
  const hubReserve = machinePaneReserve(TRUNK_X + 93, paneOpen);
  const groupKey = chain.map((node) => node.revisionId).join(',') + '|' + selectedId + '|' +
    (outbound ? outbound.length : -1) + '|' + inbound.length + '|' + selView.state +
    '|' + Object.entries(expandedRefs).filter(([, v]) => v).map(([k]) => k).join(',');
  useEffect(() => {
    const element = svgRef.current;
    if (!element) return;
    const zoom = d3.zoom<SVGSVGElement, unknown>().scaleExtent([0.45, 2.4])
      .filter((event) => event.type === 'wheel' || (!event.button && !event.target.closest('button, [data-plot-node], .d3-draggable-node')))
      .on('zoom', (event) => {
        worldRef.current?.setAttribute('transform', event.transform.toString());
        setScale(event.transform.k);
      });
    zoomRef.current = zoom;
    const canvas = d3.select(element).call(zoom).on('dblclick.zoom', null);
    return () => {
      canvas.on('.zoom', null);
    };
  }, []);
  useEffect(() => {
    if (!worldRef.current) return;
    const elements = d3.select(worldRef.current).selectAll<SVGGElement, unknown>('[data-plot-node]');
    const drag = d3.drag<SVGGElement, unknown>().container(() => worldRef.current!)
      .clickDistance(4).on('drag', function (event) {
        const key = this.dataset.plotNode!;
        const coord = this.transform.baseVal.consolidate()?.matrix;
        const x = coord?.e ?? 0;
        const y = coord?.f ?? 0;
        setPositions((prev) => ({ ...prev, [key]: { x: (prev[key]?.x ?? x) + event.dx, y: (prev[key]?.y ?? y) + event.dy } }));
      });
    elements.call(drag);
    return () => {
      elements.on('.drag', null);
    };
  }, [groupKey]);
  const zoomBy = (factor: number) => {
    if (svgRef.current && zoomRef.current) d3.select(svgRef.current).call(zoomRef.current.scaleBy, factor);
  };
  const reset = () => {
    setPositions({});
    if (svgRef.current && zoomRef.current) d3.select(svgRef.current).call(zoomRef.current.transform, d3.zoomIdentity);
  };

  /** 左栏上游依据卡（wf_3）：出链按任务包分组折叠，卡面只显【任务包名+核心文档名】；
   *  多成员组点击展开（展开态成员卡 title 才透出完整路径），单成员组点击直达目标。 */
  const renderRefGroup = (group: { pkgId: string; pkgName: string; edges: RelationEdge[] }, slotY: number) => {
    const expanded = expandedRefs[group.pkgId] === true;
    const first = byId.get(group.edges[0].target_id);
    if (!first) return null;
    const n = group.edges.length;
    const p = position('refg-' + group.pkgId, REF_X, slotY);
    const trunkAnchor = Math.min(Math.max(slotY + REF_H / 2, 130), trunkEnd);
    const open = () => setExpandedRefs((prev) => ({ ...prev, [group.pkgId]: !prev[group.pkgId] }));
    const title = expanded
      ? group.edges.map((edge) => byId.get(edge.target_id)?.relative_path ?? '').filter(Boolean).join('\n')
      : n > 1 ? '点击展开查看包内文档与完整路径' : '';
    return <g key={'refg-' + group.pkgId}>
      <path d={curve(trunkAnchor, p.x + REF_W, p.y + REF_H / 2)} style={{ stroke: REF_OUT_COLOR }} strokeDasharray="4 5" opacity=".5" fill="none"/>
      <g data-plot-node={'refg-' + group.pkgId} transform={`translate(${p.x} ${p.y})`}>
        <foreignObject width={REF_W} height={REF_H}>
          <button className="event-link-card machine-link-card" title={title}
            onClick={() => { if (n === 1) goLink(first.file_id); else open(); }}>
            <small>{n > 1 ? `上游依据 · ${n} 篇` : group.edges[0].label}</small>
            <strong>{`【${group.pkgName}】${basenameOf(first.relative_path)}${n > 1 ? ` · 等 ${n} 篇` : ''}`}</strong>
          </button>
        </foreignObject>
      </g>
      {expanded && group.edges.map((edge, j) => {
        const other = byId.get(edge.target_id);
        if (!other) return null;
        const mKey = 'refm-' + group.pkgId + '-' + j;
        const my = slotY + (j + 1) * REF_GAP;
        const mp = position(mKey, REF_X, my);
        const mAnchor = Math.min(Math.max(my + REF_H / 2, 130), trunkEnd);
        return <g key={mKey}>
          <path d={curve(mAnchor, mp.x + REF_W, mp.y + REF_H / 2)} style={{ stroke: REF_OUT_COLOR }} strokeDasharray="4 5" opacity=".35" fill="none"/>
          <g data-plot-node={mKey} transform={`translate(${mp.x} ${mp.y})`}>
            <foreignObject width={REF_W} height={REF_H}>
              <button className="event-link-card machine-link-card"
                title={`${other.relative_path}${edge.locator ? ' · L' + edge.locator.startLine : ''}`}
                onClick={() => goLink(other.file_id)}>
                <small>{edge.label}</small>
                <strong>{basenameOf(other.relative_path)}</strong>
              </button>
            </foreignObject>
          </g>
        </g>;
      })}
    </g>;
  };

  return <section ref={hostRef} className="event-workspace" hidden={!active} aria-label="文档版本时光机">
    <div className="event-toolbar" role="toolbar" data-slot="toolbar" aria-label="版本时光机工具栏">
      <button onClick={() => onBack(trail.length - 1)} aria-label="返回上一级画布"><ArrowLeft size={15}/> 返回</button>
      <nav aria-label="图谱路径"><button onClick={() => onBack(0)}>工程画布</button>
        {trail.map((item, i) => <span key={i}><ChevronRight size={12}/><button onClick={() => onBack(i + 1)} title={item.name}>{item.name}</button></span>)}
      </nav>
      <span className="event-order">
        {chain.length} 个版本 · {axisNotice.badge} · 新 → 旧
        {axisNotice.notice && (
          <span role="status" style={{ color: EVICT_COLOR }}> · {axisNotice.notice}</span>
        )}
      </span>
      {/* U04 · 纸面 / 夜航双主题分段钮（与星图同源 canvasThemeStore；主题值不入 React state） */}
      <MachineThemeSegmented onChange={handleMachineThemeChange} />
    </div>
    <div className="event-stage event-stage-machine">
      <div className="event-center">
        <div className="event-plot" data-machine-left-min-width="360">
          <svg
            ref={svgRef}
            viewBox="0 0 794 640"
            preserveAspectRatio={paneOpen ? 'xMinYMid meet' : 'xMidYMid meet'}
            className="event-svg"
            aria-label="文档版本时光机画布"
          >
            <g ref={worldRef}>
              {/* U04 · 发光渐变版本轴：几何 path 与旧实现逐字一致（tl02 保绿），视觉升级为
                  「宽而淡的光晕层 + 渐变主轴」——渐变起于选中色 --cv-lane-unknown、
                  收于 --cv-trunk，两端在夜航/纸面双档均 ≥3:1（图形级 AA）。
                  渐变 stop 用 style.stopColor（SVG 表现属性不吃 var()，须挂样式）。 */}
              <defs>
                <linearGradient id="machine-trunk-axis" gradientUnits="userSpaceOnUse"
                  x1={TRUNK_X} y1={TRUNK_TOP_Y} x2={TRUNK_X} y2={trunkEnd}>
                  <stop offset="0" style={{ stopColor: SELECT_COLOR }} />
                  <stop offset="1" style={{ stopColor: TRUNK_COLOR }} />
                </linearGradient>
              </defs>
              <path d={trunkPath} fill="none" className="machine-trunk-halo"
                style={{ stroke: SELECT_COLOR }} strokeWidth={16} strokeLinecap="round" />
              <path d={trunkPath} fill="none" className="machine-trunk-axis"
                style={{ stroke: 'url(#machine-trunk-axis)' }} strokeWidth={5} strokeLinecap="round" />
              <foreignObject x={TRUNK_X - 93} y={20} width={186 - hubReserve} height={76}>
                <button className="event-hub" onClick={() => openOriginal()} title={file.title}>
                  <small>{file.format.toUpperCase()} · 版本时光机</small><strong>{file.title}</strong>
                </button>
              </foreignObject>

              {loading && <text x={TRUNK_X} y={250} textAnchor="middle" style={{ fill: MUTED_COLOR }} fontSize={12}>正在读取版本链…</text>}
              {!loading && historyError && <>
                <foreignObject x={TRUNK_X - 110} y={216} width={220} height={48}>
                  <div role="alert" style={{ color: 'var(--cv-del)', font: '12px var(--font-mono)', textAlign: 'center' }}>{historyError}</div>
                </foreignObject>
                <foreignObject x={TRUNK_X - 60} y={272} width={120} height={34}>
                  <button className="event-read" onClick={() => setHistoryNonce((n) => n + 1)}>重试</button>
                </foreignObject>
              </>}
              {!loading && !historyError && history && !chain.length &&
                <foreignObject x={TRUNK_X - 75} y={NODE_Y0 - 4} width={NODE_W} height={NODE_H + 10}>
                  <button className="event-node machine-node" onClick={() => openOriginal()} title="该文件暂无版本记录">
                    <small>暂无版本记录</small><strong>{file.title}</strong><em>点击打开原文</em>
                  </button>
                </foreignObject>}

              {/* 版本轴节点：自上而下 v3→v2→v1（上新下旧）
                  v0.8 R8 卡面升级：头部升版本胶囊 + 💡核心结论 clamp-1 行（coreConclusionOfMarkdown
                  既有导出；正文按需拉取，未拉取/无结论回退日期行）——NODE_W×NODE_H 卡尺寸与
                  timeMachine* 轴几何一字不动（tl02 保绿），只换信息排布；timeBasis 迁 title
                  U04 司辰琉璃化：卡面重组为玻璃圆角卡——vN 徽标 + 相对时间 + 微型增删比例条
                  （+add/-del，走服务端真实行数；无数据留空槽不伪造）+ 基线/当前角标 */}
              {chain.map((node, index) => {
                const key = 'rev-' + node.revisionId;
                const p = position(key, TRUNK_X - NODE_W / 2, nodeY(index) - NODE_H / 2);
                const isSelected = node.revisionId === selectedId;
                const nodeContent = contents[node.revisionId];
                const nodeConclusion =
                  isMd && nodeContent !== undefined ? coreConclusionOfMarkdown(nodeContent) : '';
                const nodeDate = node.occurredAt ? node.observedAtLabel : '日期待考';
                const deltaStat = chapterDeltaOf(node.revisionId);
                const delta = deltaStat ? computeVersionDeltaBar(deltaStat.added, deltaStat.removed) : null;
                const relative = versionRelativeLabel(node.anchorAt, nowMs);
                return <g key={key} data-plot-node={key} transform={`translate(${p.x} ${p.y})`}>
                  <foreignObject width={NODE_W - nodeReserve} height={NODE_H}>
                    <button className={'event-node machine-node' + (isSelected ? ' selected' : '')}
                      onClick={() => setSelectedId(node.revisionId)}
                      title={node.label + ' · ' + nodeDate +
                        (node.occurredAt ? ' · ' + node.timeBasis : '') +
                        (delta?.hasData ? ` · ${delta.label} 行（章节级变更行数，相对上一版）` : '')}>
                      <small>
                        <span className="machine-version-pill">{node.label}</span>
                        <span className="machine-node-badges">
                          {node.isBaseline && <em className="machine-node-badge is-baseline">初始基线</em>}
                          {!node.snapshotAvailable && <em className="machine-node-badge is-evicted">快照已淘汰</em>}
                          {isSelected && <em className="machine-node-badge is-current">当前</em>}
                        </span>
                      </small>
                      <strong className="machine-node-conclusion">
                        {nodeConclusion
                          ? `💡 ${nodeConclusion}`
                          : `${nodeDate}${node.occurredAt && node.precisionDay ? ' · 仅日期' : ''}`}
                      </strong>
                      <em>
                        {delta?.hasData && (
                          <span className="machine-node-delta" data-machine-delta={node.revisionId}
                            title="章节级变更行数（相对上一版）· 与右侧检查器「相对 vN」同口径">
                            {delta.label}
                          </span>
                        )}
                        {`${delta?.hasData ? '· ' : ''}${relative || nodeDate} · ${(node.sizeBytes / 1024).toFixed(1)}KB`}
                      </em>
                      {delta?.hasData && (
                        <span className="machine-node-delta-bar" aria-hidden="true"
                          data-machine-delta-bar={node.revisionId}>
                          <i className="machine-node-delta-add" style={{ width: `${delta.addedPct}%` }} />
                          <i className="machine-node-delta-del" style={{ width: `${delta.removedPct}%` }} />
                        </span>
                      )}
                    </button>
                  </foreignObject>
                </g>;
              })}

              {/* wf_3 选中版核心结论块：摘『核心结论』/首节 summaryText，置于 Diff 卡区上方（MD 专属；多模态格式由对比面板承载） */}
              {selectedNode && isMd && selContent !== undefined && (() => {
                const conclusion = coreConclusionOfMarkdown(selContent);
                if (!conclusion) return null;
                const key = 'diff-conclusion';
                const y = selY - 16 - CONC_H - CARD_GAP;
                const p = position(key, CARD_X, y);
                return <g key={key}>
                  <path d={curve(selY, p.x, p.y + CONC_H / 2)} style={{ stroke: SELECT_COLOR }} opacity=".5" fill="none"/>
                  {/* U04 · 柔和贝塞尔流光引线：细亮段沿引线扫过一遍（key 随选中版本变化 → 切版即重播；
                      纯装饰层，reduce 下整层隐藏，基线引线恒在） */}
                  <path key={`flow-${selectedNode.revisionId}-${key}`} d={curve(selY, p.x, p.y + CONC_H / 2)}
                    className="glx-machine-lead-flow" style={{ stroke: SELECT_COLOR }} fill="none"/>
                  <g data-plot-node={key} transform={`translate(${p.x} ${p.y})`}>
                    <foreignObject width={CARD_W} height={CONC_H}>
                      <div className="event-node machine-node" title={conclusion}>
                        <small><span style={{ color: MUTED_COLOR }}>💡 核心结论</span><span>{selectedNode.label}</span></small>
                        <strong style={{ WebkitLineClamp: 3 }}>{conclusion}</strong>
                      </div>
                    </foreignObject>
                  </g>
                </g>;
              })()}

              {/* 选中版本的 Diff 卡（MD）：只弹该版本相对上一版改动的章节，未改动章节绝不出现 */}
              {selectedNode && isMd && selView.state === 'diff' && selView.changes.map((change, i) => {
                const key = 'diff-' + change.line + '-' + change.kind;
                const p = position(key, CARD_X, selY - 16 + i * (CARD_H + CARD_GAP));
                return <g key={key}>
                  <path d={curve(selY, p.x, p.y + CARD_H / 2)} style={{ stroke: SELECT_COLOR }} opacity=".5" fill="none"/>
                  {/* U04 · 流光引线（切版重播；纯装饰层，reduce 下隐藏） */}
                  <path key={`flow-${selectedNode.revisionId}-${key}`} d={curve(selY, p.x, p.y + CARD_H / 2)}
                    className="glx-machine-lead-flow" style={{ stroke: SELECT_COLOR }} fill="none"/>
                  <g data-plot-node={key} transform={`translate(${p.x} ${p.y})`}>
                    <foreignObject width={CARD_W} height={CARD_H}>
                      <button className="event-node machine-node" onClick={() => openOriginal(change.line)}
                        title={change.title + ` +${change.added}/-${change.removed} 行`}>
                        <small><span style={{ color: KIND_COLOR[change.kind] }}>[{change.kind}]</span>
                          <span>{change.containsSubsections ? '含子节' : ''}</span></small>
                        <strong>{change.title}</strong>
                        <em>{`+${change.added} / -${change.removed} 行 · L${change.line}${change.end !== change.line ? '–' + change.end : ''}`}</em>
                      </button>
                    </foreignObject>
                  </g>
                </g>;
              })}
              {/* v1 初始基线（MD）：一张章节清单汇总卡，不逐章堆卡 */}
              {selectedNode && isMd && selView.state === 'baseline' && (() => {
                const listHeight = Math.min(selView.sections.length, 10) * 15;
                const height = 40 + listHeight + 8;
                const key = 'diff-baseline';
                const p = position(key, CARD_X, selY - 16);
                return <g key={key}>
                  <path d={curve(selY, p.x, p.y + Math.min(height, 120) / 2)} style={{ stroke: SELECT_COLOR }} opacity=".5" fill="none"/>
                  <g data-plot-node={key} transform={`translate(${p.x} ${p.y})`}>
                    <foreignObject width={CARD_W} height={height}>
                      <button className="event-node machine-node" onClick={() => openOriginal()} title="初始基线 · 全部章节清单">
                        <small><span style={{ color: REF_OUT_COLOR }}>[初始基线]</span><span>{selView.sections.length} 个章节</span></small>
                        <span className="machine-section-list">
                          {selView.sections.slice(0, 10).map((section) =>
                            <em key={section.line}>{`${section.title} · L${section.line}${section.end !== section.line ? '–' + section.end : ''}`}</em>)}
                          {selView.sections.length > 10 && <em>{`…共 ${selView.sections.length} 个`}</em>}
                        </span>
                      </button>
                    </foreignObject>
                  </g>
                </g>;
              })()}
              {/* 快照淘汰/读取失败：元数据卡，绝不以当前内容冒充旧版 */}
              {selectedNode && (selView.state === 'unavailable' || selView.state === 'prev-unavailable') && (() => {
                const message = selView.state === 'unavailable'
                  ? '与上一版差异不可用（快照已淘汰）'
                  : selView.reason === 'evicted'
                    ? '与上一版差异不可用（快照已淘汰）'
                    : '与上一版差异不可用（正文读取失败）';
                const key = 'diff-unavailable';
                const p = position(key, CARD_X, selY - 16);
                return <g key={key}>
                  <path d={curve(selY, p.x, p.y + CARD_H / 2)} style={{ stroke: EVICT_COLOR }} strokeDasharray="4 5" opacity=".6" fill="none"/>
                  <g data-plot-node={key} transform={`translate(${p.x} ${p.y})`}>
                    <foreignObject width={CARD_W} height={CARD_H}>
                      <div className="event-node machine-node" title={message}>
                        <small><span style={{ color: EVICT_COLOR }}>[快照已淘汰]</span></small>
                        <strong>{message}</strong>
                        <em>仅保留版本元数据</em>
                      </div>
                    </foreignObject>
                  </g>
                </g>;
              })()}
              {selectedNode && selView.state === 'pending' && (() => {
                const key = 'diff-pending';
                const p = position(key, CARD_X, selY - 16);
                return <g key={key}>
                  <foreignObject width={CARD_W} height={40}>
                    <div className="event-node machine-node" role="status">
                      <small><Loader2 size={12} className="animate-spin"/> 正在读取版本正文…</small>
                    </div>
                  </foreignObject>
                  <path d={curve(selY, p.x, p.y + 20)} style={{ stroke: MUTED_COLOR }} strokeDasharray="4 5" opacity=".4" fill="none"/>
                </g>;
              })()}

              {/* 左=上游依据（出链）：按任务包分组折叠，卡面只显【任务包名+核心文档名】 */}
              {outbound &&
                <text x={REF_X} y={REF_TITLE_Y} style={{ fill: MUTED_COLOR }} fontSize={11} fontFamily="var(--font-mono)">上游依据 · {outbound.length} 篇</text>}
              {outbound && outGroups!.map((group, gi) =>
                renderRefGroup(group, REF_Y0 + refSlotStart[gi] * REF_GAP))}
              {outbound === null &&
                <text x={REF_X} y={REF_TITLE_Y} style={{ fill: MUTED_COLOR }} fontSize={11} fontFamily="var(--font-mono)">引用解析需先读取选中版正文…</text>}

              {/* 司辰·时间之神：点击切到下一版本；U04 起随当前选中版本阻尼跟随
                  （位移走 transform 过渡，版本节点本身零位移——数据区禁飞） */}
              <text x={57} y={306} style={{ fill: MUTED_COLOR }} fontSize={9.5} fontFamily="var(--font-mono)">点击切到下一版本</text>
              <g transform={`translate(55 ${CHRONOS_BASE_Y})`}>
                <g className="glx-axis-follow"
                  style={{ '--glx-follow-y': `${chronosOffset}px` } as CSSProperties}>
                  <g transform="scale(.86)">
                    {/* 切版流光：装饰光环，key 随选中版本变化 → 每次切版重播一圈（reduce 下整层隐藏） */}
                    <circle cx={68} cy={64} r={62} className="glx-machine-flow-pulse"
                      key={selectedId ?? 'none'} />
                    {active && <ChronosMascotNode x={0} y={0} isHovered={hover} isSelected={false} activeTimeSlice="all"
                      caption={mascotCaption} onClickCycleTime={cycleToNext}
                      onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}/>}
                  </g>
                </g>
              </g>
            </g>
          </svg>
          <div className="event-zoom">
            <span>X-Ray</span><button aria-label="缩小画布" onClick={() => zoomBy(.85)}><Minus size={14}/></button>
            <span>{Math.round(scale * 100)}%</span><button aria-label="放大画布" onClick={() => zoomBy(1.15)}><Plus size={14}/></button>
            <button aria-label="重置画布" onClick={reset}><RotateCcw size={13}/></button>
          </div>
          {/* D03 · 多模态对比面板：停靠 .event-plot（position:relative 既有锚）右缘，
              覆盖 MD 专属 Diff 卡区（多模态格式该区本就为空）。普通 HTML 层不入 d3.zoom 事件路径 */}
          {paneModel.kind !== 'hidden' && selectedNode && (() => {
            const subtitle = prevNode
              ? `v${prevNode.seq} → v${selectedNode.seq}`
              : `${selectedNode.label} · 初始基线`;
            const title = paneModel.kind === 'md'
              ? (mdPaneMode === 'human' ? '人类可读对比 · 标题结构 / 决定与待办 / 关键增删段' : '源码行 Diff')
              : paneModel.kind === 'svg' ? '图纸对比 · 叠影 / 擦除'
              : paneModel.kind === 'table' ? '表格数值对比 · 增删行列与单元格变化'
              : paneModel.kind === 'xlsx' ? '工作簿数值对比 · 逐表逐格'
              : '多模态对比';
            return <DiffSidePane
              badge={file.format.toUpperCase()}
              subtitle={subtitle}
              title={title}
              open={paneOpen}
              onToggle={() => setPaneOpen((v) => !v)}
            >
              {/* U04 · 切版淡变：内容层挂 .glx-fade-in（纯 opacity，--dur-1 --ease-fade），
                  key 随「选中版 + 面板态」变化 → 点击版本切换时右侧多模态 Diff 面板柔和淡变衔接 */}
              <div className="glx-fade-in" key={paneSignature} data-machine-pane-fade="">
              {paneModel.kind === 'md' && <>
                <div className="mb-2 flex gap-1.5" role="tablist" aria-label="对比视图切换">
                  {(['human', 'source'] as const).map((mode) => (
                    <button
                      key={mode}
                      type="button"
                      role="tab"
                      aria-selected={mdPaneMode === mode}
                      data-machine-md-mode={mode}
                      onClick={() => setMdPaneMode(mode)}
                      className="rounded px-2 py-0.5 text-[11px]"
                      style={{
                        background: mdPaneMode === mode ? 'var(--cv-card)' : 'transparent',
                        color: mdPaneMode === mode ? 'var(--cv-ink-3)' : 'var(--cv-ink-meta)',
                        border: `1px solid ${mdPaneMode === mode ? 'color-mix(in srgb, var(--cv-lav) 40%, transparent)' : 'transparent'}`,
                      }}
                    >
                      {mode === 'human' ? '人类视图' : '源码行 Diff'}
                    </button>
                  ))}
                </div>
                <MdHumanDiffPanel result={paneModel.result} mode={mdPaneMode} onJumpLine={(line) => openOriginal(line)}/>
              </>}
              {paneModel.kind === 'svg' && (
                <SvgComparePanel
                  oldSvg={paneModel.oldSvg}
                  newSvg={paneModel.newSvg}
                  diff={paneModel.result}
                  oldLabel={prevNode ? `v${prevNode.seq}` : '旧版'}
                  newLabel={`v${selectedNode.seq}`}
                />
              )}
              {paneModel.kind === 'table' && (
                <TableDiffPanel result={paneModel.result} format={file.format === 'tsv' ? 'tsv' : 'csv'}/>
              )}
              {paneModel.kind === 'xlsx' && <TableDiffPanel result={paneModel.result} format="xlsx"/>}
              {(paneModel.kind === 'pending' || paneModel.kind === 'unavailable' || paneModel.kind === 'baseline') && (
                <p role="status" className="text-[12px]" style={{ color: 'var(--cv-ink-meta)' }}>{paneModel.note}</p>
              )}
              </div>
            </DiffSidePane>;
          })()}
        </div>
      </div>
      <aside className="event-panel event-inspector" aria-label="版本依据">
        <small>已选中 · 层级 {trail.length}</small>
        <h2>{file.title}</h2>
        <div className="event-location">{`任务包 · ${myPkg.name}`}</div>
        {selectedNode && <>
          <div className="event-meta">
            <span>{file.format.toUpperCase()} · {selectedNode.label}</span>
            <span>{`阶段 · ${stageOfPath(file.relative_path)}`}</span>
            <span>{selectedNode.occurredAt ? selectedNode.observedAtLabel + (selectedNode.precisionDay ? ' · 仅日期' : '') : '日期待考'}</span>
            {selectedNode.occurredAt && <span>{selectedNode.timeBasis}</span>}
            <span style={selectedNode.snapshotAvailable ? undefined : { color: EVICT_COLOR }}>
              {selectedNode.snapshotAvailable ? '快照可用' : '快照已淘汰'}
            </span>
          </div>
          <p className="machine-diff-summary">
            {selView.state === 'diff' && prevNode &&
              `相对 v${prevNode.seq}：${selView.changes.length} 个章节变更 (+${selView.totalAdded}/-${selView.totalRemoved} 行)`}
            {selView.state === 'baseline' && `初始基线 · ${selView.sections.length} 个章节`}
            {selView.state === 'ready' && multimodalCaption(paneModel, selectedNode.seq)}
            {(selView.state === 'unavailable' || (selView.state === 'prev-unavailable' && selView.reason === 'evicted')) &&
              '差异不可用（快照已淘汰）'}
            {selView.state === 'prev-unavailable' && selView.reason === 'fetch-failed' && '差异不可用（正文读取失败）'}
            {selView.state === 'pending' && '正在读取版本正文…'}
          </p>
          {/* 语义 Diff 摘要（PRD 3.5 / 方案 F7）：选中版与其父版的任务队列口径摘要——
              三指标 + Checkpoint；端点未落地时卡片内如实提示，本地章节对比不受影响 */}
          {isMd && selectedNode.snapshotAvailable && prevNode?.snapshotAvailable && (
            <div className="space-y-1">
              <button
                className="event-read"
                data-machine-diff-summary=""
                onClick={() => requestSemanticDiff(selectedNode, prevNode)}
              >
                语义变更摘要（{prevNode.label} → {selectedNode.label}）
              </button>
              {semanticDiff && semanticDiff.label === `${prevNode.label} → ${selectedNode.label}` && (
                <DiffSummaryCard
                  result={semanticDiff.result}
                  loading={semanticDiff.loading}
                  error={semanticDiff.error}
                  title={`变更摘要 ${semanticDiff.label}`}
                />
              )}
            </div>
          )}
        </>}
        <button className="event-read" onClick={() => openOriginal()}><BookOpen size={14}/> 打开原文</button>
        {fileDecisions.length > 0 && <><h3>相关决策</h3>{fileDecisions.map((d) =>
          <div key={d.decision_id + d.evidences[0]?.lineStart} className="event-doc-link">{d.question}<em>{d.status}</em></div>)}</>}
        {downstreamGroups.length > 0 && <>
          <h3>{`同任务包资料 · ${downstreamGroups.reduce((n, g) => n + g.items.length, 0)} 篇`}</h3>
          <div className="machine-siblings">
            {downstreamGroups.map((group) => (
                <details key={group.pkgId}
                  open={openDownstream[group.pkgId] ?? (group.pkgId === myPkg.id && group.items.length <= 6)}
                  onToggle={(e) => {
                    // React 在事件派发结束即把 currentTarget 置 null，而 setState 的 updater
                    // 可能延后到渲染期才执行——在 updater 内读 e.currentTarget.open 会抛
                    // TypeError 并连带整棵树崩成白屏（实机复现：星图下钻单文档时光机）。
                    // 修法：派发内同步取 open 真值，updater 只消费布尔量（语义不变）。
                    const detail = e.currentTarget as HTMLDetailsElement | null;
                    const nextOpen = detail ? detail.open : !(openDownstream[group.pkgId] ?? false);
                    setOpenDownstream((prev) => ({ ...prev, [group.pkgId]: nextOpen }));
                  }}>

                <summary>{group.pkgName}</summary>
                {group.items.map((it) => (
                  <button key={it.file.file_id} className="event-doc-link" onClick={() => onGo(it.file)}>
                    {basenameOf(it.file.relative_path)}
                    <em style={it.referenced ? { color: REF_IN_COLOR } : undefined}>
                      {it.referenced ? '被引用' : it.file.format.toUpperCase()}
                    </em>
                  </button>
                ))}
              </details>
            ))}
          </div>
        </>}
      </aside>
    </div>
  </section>;
}

/** D03：多模态格式司辰一句话摘要（与对比面板计数同源；模块层纯函数便于复用/断言） */
function multimodalCaption(model: PaneModel, seq: number): string {
  switch (model.kind) {
    case 'md':
      return `v${seq} · ${model.result.stats.sectionsChanged} 章变更 · ${model.result.decisionChanges.length} 决定 · ${model.result.todoChanges.length} 待办`;
    case 'svg':
      return model.result.ok
        ? `SVG · +${model.result.added} -${model.result.removed} ~${model.result.changed} 图元`
        : 'SVG · 图元超预算，诚实拒绝';
    case 'table':
      return model.result.ok
        ? `表格 · +${model.result.addedRows} -${model.result.removedRows} 行 · ${model.result.cellChanges} 格变化`
        : '表格 · 超预算，诚实拒绝';
    case 'xlsx':
      return model.result.ok
        ? `工作簿 · ${model.result.sheets.length} 表变化 · 新增 ${model.result.addedSheets.length} 删除 ${model.result.removedSheets.length}`
        : '工作簿 · 结构化数据不可用';
    case 'baseline':
      return '初始基线';
    case 'unavailable':
      return '差异不可用';
    case 'pending':
      return '读取差异中…';
    default:
      return '版本时光机';
  }
}
