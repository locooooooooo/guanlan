/**
 * D01-a 四层拆解 · 纯函数几何布局引擎（任务卡 D01-a ②）。
 *
 * 从 GraphCanvasView.tsx 模块层原样迁入的全部几何常量与纯函数——零 UI 依赖、
 * 零 React 依赖、可单测。消费方：
 *  - GraphCanvasView.tsx（经 re-export 保持既有测试导入路径：test/gc-12-date-rail /
 *    wf2-same-day-merge / starfix2 / canvas-theme 直接 `from '../src/components/GraphCanvasView'`）；
 *  - graph/ 图层组件（scene/overlay/chrome）与 useGraphCanvasController。
 *
 * 迁移纪律：只搬移不改写——每个常量/函数体与拆解前逐字一致（像素回归护栏）。
 */

import { bucketTickLabel } from '../../utils/graphEvents';
import type { CanvasRulerTick } from '../../utils/graphEvents';
import type { EventDayGranularity } from '../../services/workspaceClient';
import type { FileFormat } from '../../types/guanlan';

/** ⑤ 全景溯源工作区内部三态：星图画布（本组件）/ 列表（TimelineView）/ 日历（CalendarBoardView）；宿主 App 持有 */
export type PanoramaMode = 'canvas' | 'list' | 'calendar';

// starfix2 T1：CAPABILITY_BADGES / BADGE_SEMANTIC_LABELS / pickSemanticCapabilityCodes
// 三块随旧「语义徽章行」退役——事件卡行4 左改 stageOfPath 阶段胶囊（卡面唯一消费者）；
// 语义中文词表单一出口仍在 graphEvents.CANVAS_SEMANTIC_LABELS（导航/图例等其他消费方不动）
export type CapabilityCode = 'MD' | 'DEC' | 'REV' | 'SVG' | 'TIM' | 'PDF' | 'REL';

/** C3：Sources 面板安全左缘（aside left-4=16px + w-[206px]；面板宽度若改必须同改）。
 *  初始缩放 / 重置 / 收起展开动画 / 平移钳制统一以它为画布可视原点，保证面板永不压住画布文字 */
export const SOURCES_PANEL_SAFE_LEFT = 222;
/** Sources 面收起为窄条后画布可视原点回退位 */
export const SOURCES_PANEL_COLLAPSED_LEFT = 36;
/** C2：司辰锚定主干左侧的水平偏移（mascot 宽约 130 + 徽章 128，全部落在主干左侧） */
export const CHRONOS_TRUNK_DX = -156;

// ================= starfix2 T1：事件卡几何（单测覆盖） =================
/** 事件卡宽（px）：贴既有富预览卡栅格值 RICH_CARD_W=280（同一画布栅格，登记取舍——
 *  工票给 288 或栅格值二选一，取栅格值保持任务空间桌面横向节奏一致）。旧 152 双行卡退役 */
export const EVENT_CARD_W = 280;
/** 事件卡高（px）：固定充足高度 + 内容 flex 自适应（foreignObject 不随内容撑高是 SVG 硬约束）。
 *  预算：p-2.5 上下 20 + 行1 标题 17 + 行2 专项 13 + 行3 摘要 clamp-2 约 29 + 行4 角标 14 +
 *  行距 gap 3×4=12 ≈ 105 ≤ 116-20，行3 超长由 line-clamp-2 收口。旧 90 高两行卡退役 */
export const EVENT_CARD_H = 116;
/** 事件卡列距（px）：列2 左缘 = 列1 左缘 + EVENT_CARD_W + 36（≥24 呼吸，卡间零重叠） */
export const EVENT_CARD_COL_GAP = 36;
/** 事件卡行距（px）：下行 y = 上行 y + EVENT_CARD_H + 24（≥24 呼吸，命中区 18px 热带零串行） */
export const EVENT_CARD_ROW_GAP = 24;

// ================= starfix2 T3：主干左上固定文字组锚点（单测覆盖） =================
/** 主干左上固定文字组（「在阅读器中打开 →」+「CHRONOS·SHA256 · …」）的 y 锚点。
 *  旧 36：第二行基线 36+18=54 落进「工程事件轴」主卡横带（main_hub y=32 高 76 → 32..108），
 *  而「· N 条事件」后缀把文字右端推过卡左缘 x=trunkX-62 → 后绘制的卡面盖住文字。
 *  上移到 10：行2 基线 28 < 卡顶 32，两行完整可读零重叠；粒度切换行（y=78）锚点不动。
 *  取舍登记：文字组整体上移 26px 让位主卡（几何上横向必然相交——主卡左缘 x=trunkX-62
 *  恒小于文字右端 trunkX-170+文字宽，让位只能走纵向）；主卡位置与主干派生零改动。 */
export const TRUNK_META_TEXT_Y = 10;

// ================= 1.2：左侧日期汇总卡独立轨道（几何铁律 · 单测覆盖） =================
// 上一版把 4 张日期卡固定在 x=266（主干 414）→ 卡横跨 266–386，正好压在司辰立绘
// （x 258–390）上，且后渲染的卡盖住立绘。修法：日期卡改走「独立左侧轨道」，
// 卡右缘同时满足「离主干 ≥120px」与「离立绘左缘 ≥16px」两条约束，取更严格者。
// 这两条约束都是 exported 常量 + 派生函数，由 test/gc-12-date-rail.test.ts 断言。
/** 日期汇总卡宽（px，与 foreignObject 同宽） */
export const DATE_CARD_W = 120;
/** 日期汇总卡高（px） */
export const DATE_CARD_H = 50;
/** 日期卡右缘 ↔ 主干中心线的水平安全距离下限（px，铁律） */
export const DATE_CARD_TRUNK_MIN_GAP = 120;
/** 日期卡右缘 ↔ 司辰立绘包围盒左缘的最小水平间隙（px）：>0 即「文字永不压立绘」 */
export const DATE_CARD_CHRONOS_MIN_GAP = 16;
/** 司辰立绘横向包围盒宽（px）：本体 image x=6 w=124（6..130）、徽章 x=4 w=128（4..132）、
 *  左翼 translate(48)+path -36（12）；取 132 覆盖全部画笔，包围盒 = [x, x+132] */
export const CHRONOS_MASCOT_WIDTH = 132;

/** 日期卡轨道左缘（相对主干中心线，px）：
 *  ① 卡右缘 ≤ trunkX − DATE_CARD_TRUNK_MIN_GAP（与主干的安全距离）
 *  ② 卡右缘 ≤ （trunkX + CHRONOS_TRUNK_DX）− DATE_CARD_CHRONOS_MIN_GAP（立绘左缘再让 16）
 *  两条同时满足 → 取更严格者，再减卡宽得卡左缘。默认 trunkX=414 时 = 122。 */
export const DATE_CARD_RAIL_TRUNK_DX =
  Math.min(
    CHRONOS_TRUNK_DX - DATE_CARD_CHRONOS_MIN_GAP,
    -DATE_CARD_TRUNK_MIN_GAP
  ) - DATE_CARD_W;

/** 日期卡轨道 x（用户空间）：随 main_hub 拖动重算，卡与主干/立绘的距离恒定 */
export function dateCardRailX(trunkX: number): number {
  return trunkX + DATE_CARD_RAIL_TRUNK_DX;
}
/** 日期卡右缘到主干中心线的水平净距（px，单测断言 ≥ DATE_CARD_TRUNK_MIN_GAP） */
export function dateCardTrunkGap(trunkX: number): number {
  return trunkX - (dateCardRailX(trunkX) + DATE_CARD_W);
}
/** 日期卡右缘到司辰立绘左缘的水平净距（px，单测断言 ≥ DATE_CARD_CHRONOS_MIN_GAP） */
export function dateCardChronosGap(trunkX: number): number {
  return trunkX + CHRONOS_TRUNK_DX - (dateCardRailX(trunkX) + DATE_CARD_W);
}
/** C3：zoom 层固定文字组（「在阅读器中打开」「粒度」）相对主干的用户坐标偏移，
 *  同时是平移钳制的用户空间下界（向左拖到极限时这组文字恰好贴面板右缘） */
export const FIXED_TEXT_TRUNK_DX = -170;
/** C2：主干时间轴纵向呼吸位（轴顶/轴底各让出 36px，不顶着主节点/底端） */
export const TRUNK_AXIS_PAD = 36;
/** 3.4：点日期/司辰切版本时的运镜时长（ms）——与 index.css 的 --dur-pan 同值 */
export const PAN_TRANSITION_MS = 500;
/** 3.2：展开时内部子卡的弹簧交错步长（ms，契约 40ms） */
export const SPRING_STAGGER_MS = 40;

// ================= wf_2：组头日期胶囊几何常量与纯函数 =================
// 三组常量（文本预算 / 按钮右缘 / 胶囊-司辰留白）供渲染断言覆盖（复用 tl02/gu-cc 既有
// exported 几何常量风格）。任何一处改动必须同步更新下方纯函数与渲染引用。
/** 组头胶囊内文本起点（盒内 local x，px） */
export const FANOUT_HEADER_TEXT_LEFT = 12;
/** 「收起/展开」按钮宽（px） */
export const FANOUT_HEADER_BUTTON_W = 58;
/** 按钮右缘距胶囊右缘（px）：按钮左缘 = 盒宽 - 82 = 盒宽 - (24 + 58) */
export const FANOUT_HEADER_BUTTON_MARGIN_RIGHT = 24;
/** 文本宽度预算偏移（px，ask 逐字口径）：fanOutBounds.width - 96 - 58(按钮宽) - 16 */
export const FANOUT_HEADER_TEXT_BUDGET_OFFSET =
  96 + FANOUT_HEADER_BUTTON_W + 16; // = 170
/** 胶囊在扇出盒内的纵向起点（px，translate(12, 10) 的 y 分量） */
export const FANOUT_HEADER_CAPSULE_TOP = 10;
/** 胶囊高（px） */
export const FANOUT_HEADER_CAPSULE_H = 26;
/** 胶囊底部与司辰纵轴（chronosPos.y）的留白下限（px，铁律：不改司辰派生，只下推胶囊） */
export const FANOUT_HEADER_CHRONOS_GAP_MIN = 20;
/** 胶囊文本字号（px，宽度估算的 em 基准） */
export const FANOUT_HEADER_TEXT_FONT_PX = 11.5;

/** 组头胶囊文本宽度预算（px）：盒宽 - 96 - 58 - 16（ask 逐字口径）。
 *  文本只允许占用该预算，『收起』按钮恒贴胶囊右缘（盒宽-82 起），任何文本长度下不重叠。 */
export function fanOutHeaderTextMaxWidth(boxWidth: number): number {
  return Math.max(0, boxWidth - FANOUT_HEADER_TEXT_BUDGET_OFFSET);
}

/** 收起按钮左缘（盒内 local x，px）：恒贴胶囊右缘 = 盒宽 - (24 + 58)。 */
export function fanOutHeaderButtonLeft(boxWidth: number): number {
  return boxWidth - (FANOUT_HEADER_BUTTON_MARGIN_RIGHT + FANOUT_HEADER_BUTTON_W);
}

/** 组头胶囊纵位（盒内 local y，px）：胶囊底与 chronosPos.y 留白恒 ≥ 20px。
 *  司辰悬于胶囊下方且间距不足（chronosY - capsuleBottom < 20）时上推胶囊至恰好 20px；
 *  上推到盒顶（0）仍不足（司辰被拖入盒区/盒上方）时钳制在盒顶——不改 chronosPos 派生
 *  （GraphCanvasView 377-391）与 cycleChronosTimeSlice 一字不动。 */
export function fanOutHeaderCapsuleY(boxTop: number, chronosY: number): number {
  const capsuleBottom = boxTop + FANOUT_HEADER_CAPSULE_TOP + FANOUT_HEADER_CAPSULE_H;
  const gap = chronosY - capsuleBottom;
  if (gap >= FANOUT_HEADER_CHRONOS_GAP_MIN) return FANOUT_HEADER_CAPSULE_TOP;
  const pushed = FANOUT_HEADER_CAPSULE_TOP - (FANOUT_HEADER_CHRONOS_GAP_MIN - gap);
  return Math.max(0, pushed);
}

/** 组头胶囊文本截断（超长省略）：按 em 预算（CJK/全角按 1em、ASCII 实际更窄，保守按全 1em
 *  估算故永不溢出预算）截断并以「…」收尾；未超预算原样返回。
 *  starfix2 T2：渲染侧已退役截断（组头改全量渲染 + 胶囊自适应宽），本函数与
 *  fanOutHeaderTextMaxWidth 保留作为宽度预算参照与既有单测口径（wf2 锁定），渲染不再消费。 */
export function fitFanOutHeaderText(text: string, maxWidthPx: number): string {
  const budgetChars = Math.max(1, Math.floor(maxWidthPx / FANOUT_HEADER_TEXT_FONT_PX));
  if (text.length <= budgetChars) return text;
  return `${text.slice(0, budgetChars - 1)}…`;
}

// ================= starfix2 T2：组头胶囊自适应宽（替代固定预算截断） =================
/** 胶囊/按钮带隙扣减（px）：旧固定胶囊宽 = 盒宽-96 的同一扣减——胶囊右缘恒距
 *  「收起」按钮左缘（盒宽-82）≥14px。starfix2 T2 渲染断言消费。 */
export const FANOUT_HEADER_BUTTON_LEFT_GAP_W = 96;
/** 组头全量文本渲染宽（px）：CJK/全角按 1em、ASCII 按 0.62em 估算（mono 字体的保守近似，
 *  估算 ≥ 实际 → 胶囊只会偏宽不会截字）。旧「盒宽-96-58-16 固定预算 + …截断」把
 *  「· N 条待展开 · 点击看全天 →」尾段截成省略号，正是本次废除的错误宽度限制。 */
export function fanOutHeaderTextWidth(text: string): number {
  let units = 0;
  for (const ch of text) {
    units += ch.charCodeAt(0) > 0xff ? 1 : 0.62;
  }
  return units * FANOUT_HEADER_TEXT_FONT_PX;
}

/** 组头胶囊自适应宽（px）= 文本全宽 + 左右内边距 24，钳制 [160, 盒宽-96]：
 *  上界取旧胶囊上界（盒宽-FANOUT_HEADER_BUTTON_LEFT_GAP_W），右缘恒在「收起」
 *  按钮左缘（盒宽-82）之前 ≥14px，全量文本与按钮任何盒宽下不重叠；
 *  下界 160 保空态文案可读。 */
export function fanOutHeaderCapsuleWidth(text: string, boxWidth: number): number {
  return Math.min(
    Math.max(160, fanOutHeaderTextWidth(text) + 24),
    Math.max(160, boxWidth - FANOUT_HEADER_BUTTON_LEFT_GAP_W)
  );
}

/** C4 泳道语义（14-hex 白名单逐项死映射）：每根光束=一个文档分类泳道。
 *  数据模型 workspaceClient.format 仅 md/svg/pdf/null——不存在「代码」分类，
 *  决策/读取问题等工作区级未判定事件统一落蓝泳道，图例标注「未判定」
 *  v0.7 V7-D15 白名单扩档登记（值共享、令牌独立）：值改 --cv-lane-* 令牌名——
 *  暗档 #F76808/#8E8AE6/#F5D90A/#4C8DFF 原样（index.css 默认块）；浅档 #C2410C/
 *  #5B4BC4/#8A621E/#2F5AA8 + 纸底 #FAF9F5 为新增浅值。泳道=文档分类数据编码，
 *  与 iris（交互色）/stage-ink（五阶段语义）三轴独立演化，不别名化现役令牌
 *  （令牌别名会静默串写编码）；同表另登记 #B4530A/#7C6FD0/#A8762B/#9A4208/
 *  #1F7A45/#C53030/#0E7490（index.css --cv-* 浅档）+#64646D（TRUNK 暗档，V7-D16 清偿）。
 *  值=令牌名 ⇒ 消费点硬边界：SVG 表现属性（stroke=/fill=）不吃 var()——四根光束
 *  stroke、泳道光点 fill 一律走 style={{}}（勘察 §5.2）；图例本就 style 消费，自动随主题。 */
export type LaneKey = 'md' | 'svg' | 'pdf' | 'unknown';
/** export 供 test/canvas-theme.test.ts 值契约断言（v0.7 增补 §4-2：泳道=数据编码轴，锁令牌名） */
export const LANE_COLORS: Record<LaneKey, string> = {
  md: 'var(--cv-lane-md)',
  svg: 'var(--cv-lane-svg)',
  pdf: 'var(--cv-lane-pdf)',
  unknown: 'var(--cv-lane-unknown)',
};
/** 泳道 x 偏移（沿用 d3RiverStrands 四条曲线的 -5/-1/+3/+7） */
export const LANE_OFFSETS: Record<LaneKey, number> = { md: -5, svg: -1, pdf: 3, unknown: 7 };
/** C1④：里程碑 Y（全画布唯一时间轴，index 0 = 最新一天 = 轴顶；数据由 graphEvents 降序给出） */
export const milestoneY = (
  index: number,
  total: number,
  axisTop: number,
  axisBottom: number
): number =>
  total <= 1
    ? (axisTop + axisBottom) / 2
    : axisTop + (index / (total - 1)) * (axisBottom - axisTop);

/** ④ 事件日期（YYYY-MM-DD）是否落在标尺刻度桶内：day 逐日 / week 7 天窗 / month 月窗 */
export const eventMatchesRulerTick = (eventDate: string, tick: CanvasRulerTick): boolean => {
  if (!eventDate) return false;
  if (tick.granularity === 'month') return eventDate.slice(0, 7) === tick.date;
  if (tick.granularity === 'week') {
    const startT = Date.parse(`${tick.date}T00:00:00Z`);
    const t = Date.parse(`${eventDate}T00:00:00Z`);
    return (
      Number.isFinite(startT) && Number.isFinite(t) && t >= startT && t <= startT + 6 * 86_400_000
    );
  }
  return eventDate === tick.date;
};

/** 1.2：单个日期在全画布的「唯一锚点文字」判定 —— 主干刻度是否标注日期文本。
 *
 *  上一版同日出现两处文字：主干 `showLabel`（i%step===0）与左侧日期汇总卡的 `nav.label`，
 *  同一 MM-DD 在主干与日期卡各写一次。修法：日期卡已承载的日期（navigator 命中的 4 天），
 *  主干不再重复标注——每个日期全画布至多 1 处文字，且该处必定是带事件计数与连线的日期卡。
 *  另保留 index 0（最新一天）的标注职责，但当它同时是日期卡锚点时同样让位。 */
export function trunkTickShowsLabel(
  index: number,
  step: number,
  date: string,
  navigatorDates: ReadonlySet<string>
): boolean {
  if (navigatorDates.has(date)) return false;
  const every = Math.max(1, Math.floor(step));
  return index === 0 || index % every === 0;
}

/** tf_6/F1：统一日期口径词形（司辰徽标/底栏胶囊/顶栏共用）——
 *  待考显「日期待考」；周/月桶与刻度标签同源同词（「MM-DD 周起」/YYYY-MM）；日粒度原样 YYYY-MM-DD */
export const sceneDateLabel = (date: string, granularity: EventDayGranularity): string => {
  if (date === '') return '日期待考';
  if (granularity === 'week' || granularity === 'month') return bucketTickLabel(date, granularity);
  return date;
};

export interface SubAgentCardModel {
  id: string;
  fileId: string;
  decisionId?: string;
  eventId?: string;
  revisionId?: string | null;
  /** C6 行1 大字：文件名（文件类）或 `编号 状态变化`（决策类） */
  fileName: string;
  /** 同组重名文件的目录前缀（空串=无歧义） */
  dirPrefix: string;
  /** C6 行1 灰色变更段：v{n-1} → v{n} / 新出现 v{n}（按 revisionId 解析真实版本号）；
   *  wf_2：mergedDay 卡由画布按 dayMergeLabel 渲染（v1 → v3 · 今日演进 2 次） */
  changeLabel: string;
  /** wf_2：任务包名（taskPackageOf(file.relative_path).name）——行1 大字前的小字 chip */
  packageName?: string;
  /** wf_2：五阶段标签（stageOfPath(file.relative_path)：蓝图/计划/决策/执行/交付/待分类） */
  packageStage?: string;
  /** C6 底部角标：[中文语义分类] HH:MM */
  cornerLabel: string;
  /** 当天时刻 HH:MM（角标的时刻分量；右栏行尾复用） */
  observedClock: string;
  /** 行2 摘要原文（headline 原样透出） */
  detail: string;
  /** starfix T6：核心变更描述（deriveCanvasChangeSummary 产物，如「修改发布机构建文档头部」）；
   *  空串=无可诚实透出的摘要（调用方回退 headline 行，绝不渲染空洞占位） */
  changeSummary?: string;
  /** starfix T6：+/− 行数（服务端 diff 链真实统计经 detail 定式回收）；null=行数不可知不伪造 */
  changeCounts?: { added: number; removed: number } | null;
  /** starfix2 T1 行1 右：版本跨度胶囊措辞（graphEvents.versionSpanCapsule 产物，
   *  如「v6 → v8 (2次)」「v8」「新出现 v3」）；空串=无版本数据，不渲染胶囊 */
  versionSpan?: string;
  /** starfix2 T1 行2：所属专项路径（taskPackageOf(file.relative_path).id，如
   *  「01-方案文档/长任务与执行记录/pdmlong006…」「04-智能体代码/MECH-WIN-001 …」）；
   *  无文件事件（决策/工作区级）为空串，渲染回退 kindLabel */
  pkgPath?: string;
  /** starfix2 T1 行3：真实修改内容摘要（graphEvents.canvasChangeDigestLine 产物
   *  「变更章节：A / B — 修改A」；appeared 卡= extractCoreSummary 正文核心结论）；
   *  空串=无可诚实透出，渲染回退 detail headline */
  digestLine?: string;
  /** starfix2 T1 行2 回退词：事件类型界面词（eventKindLabel 既有出口，决策/工作区级事件无专项时透出） */
  kindLabel?: string;
  format: FileFormat;
  /** T06：真实格式无法判定（null）时置位——展示落中性，不再按 md 兜底着色 */
  formatNeutral?: boolean;
  roleLabel: string;
  // starfix2 T1：activeBadges/highlightedBadges 随旧「语义徽章行」退役（卡面行4 左改阶段胶囊）
  peakMetric: string;
  peakSub: string;
  secondaryMetric: string;
  secondarySub: string;
  activityStats: {
    mdChanges: number;
    svgNodes: number;
    pdfRefs: number;
    decisionLinks: number;
  };
  outputSummary: string;
  timeRange: string;
  /** v0.4：真实日期（YYYY-MM-DD / 日期待考）；isNodeInActiveTimeSlice 与右栏依赖 */
  timeBucket: string;
}

export interface LeftSourceNodeModel {
  id: string;
  fileId: string;
  /** v0.4：日期导航节点的目标日期（'' = 日期待考）；为空表示这是个文件入口 */
  date?: string;
  badge: CapabilityCode;
  shortBadge: string;
  label: string;
  tokOrMeta: string;
  /** 日期汇总卡主格式简标（如 MD / SVG / MJS），单行不截断 */
  dominantFormat?: string;
  /** 悬停完整明细（全部格式计数与累计沉淀） */
  fullMetaTooltip?: string;
  /** 当日文档结晶强度档位（1..5，供左卡微粒结晶点渲染） */
  grainLevel?: number;
  /** 截至当日累计沉淀记录数 */
  cumulativeEvents?: number;
  roundLabel: string;
  yOffset: number;
  targetTrunkY: number;
  timeBucket: string;
}

export type NodePositionMap = Record<string, { x: number; y: number }>;

// Spacious, un-crowded coordinates matching Claude's Anthropic Editorial Dark Palette & X-Ray layout
// starfix2 T1：sub_01..sub_08 事件卡槽位随卡尺寸重排（旧 152x90 双列 x=468/638、行距 106
// 在 280px 宽卡下横向重叠 104px）——双列 x=468 / 468+280+36、行距 116+24；
// 导出供单测锁定「同列行距 ≥ 卡高+24、同行列距 ≥ 卡宽+36」的堆叠间距铁律
export const DEFAULT_NODE_POSITIONS: NodePositionMap = {
  main_hub: { x: 352, y: 32 },
  chronos_deity: { x: 112, y: 266 }, // Time Deity presiding between Timeline Scrubber (left) and Version River (right)
  // 1.2：四张左侧卡（1 张文件入口 + 3 张日期汇总卡）默认落在独立左侧轨道
  // dateCardRailX(414)=122，不再用 266（266+120=386 会压住 x 258–390 的司辰立绘）
  src_round15: { x: 122, y: 146 },
  src_svg_engine: { x: 122, y: 146 },
  src_four_spec: { x: 122, y: 214 },
  src_receipt: { x: 122, y: 432 }, // Generous vertical breathing space
  sub_01: { x: 468, y: 248 },
  sub_02: { x: 468 + EVENT_CARD_W + EVENT_CARD_COL_GAP, y: 248 },
  sub_03: { x: 468, y: 248 + EVENT_CARD_H + EVENT_CARD_ROW_GAP },
  sub_04: { x: 468 + EVENT_CARD_W + EVENT_CARD_COL_GAP, y: 248 + EVENT_CARD_H + EVENT_CARD_ROW_GAP },
  sub_05: {
    x: 468,
    y: 248 + (EVENT_CARD_H + EVENT_CARD_ROW_GAP) * 2,
  },
  sub_06: {
    x: 468 + EVENT_CARD_W + EVENT_CARD_COL_GAP,
    y: 248 + (EVENT_CARD_H + EVENT_CARD_ROW_GAP) * 2,
  },
  // 场景上限 6 卡（maxCardsPerGroup=6）→ 行4 恒空置；槽位保留派生一致性（力导向布局消费全集）
  sub_07: {
    x: 468,
    y: 248 + (EVENT_CARD_H + EVENT_CARD_ROW_GAP) * 3,
  },
  sub_08: {
    x: 468 + EVENT_CARD_W + EVENT_CARD_COL_GAP,
    y: 248 + (EVENT_CARD_H + EVENT_CARD_ROW_GAP) * 3,
  },
};
