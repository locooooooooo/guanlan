/**
 * v0.8 任务空间桌面 · 280px 富预览卡（R2 / 组件契约 C4）。
 *
 * 「不点开就能看懂」的画布卡面：头部=标题（truncate）+版本胶囊（versionLabel 原串，
 * 如「BUILD · v8」）；主体=💡核心结论行（clamp 2）+ 前 3 行正文预览或变更章节行
 * （kind 色与 DocumentTimeMachineView.KIND_COLOR 同源令牌，走 canvasWidgets.css
 * [data-kind] 档）；SVG 文档直出缩略图（svgThumbDataUri 由调用方经
 * sanitizeSvgForPreview 清洗后编码）。
 *
 * 验收锚点：data-cv-rich-card（卡根）、data-cv-rich-card-version（值=versionLabel
 * 原串——与画布票 R2 统一口径，评审 #8 裁决）。
 * 舷窗纪律：样式全走 .cvw-*（canvasWidgets.css），本文件零内联色值。
 */

// v0.8 总装：本文件的 css 装载上移 App.tsx（指挥授权越权单行修复）——node --test/tsx
// 测试链（gc-12/wf2/canvas-theme 经 GraphCanvasView 导出常量）无法加载 .css 扩展名，
// 组件内 import 会令三个测试文件级失败（ERR_UNKNOWN_FILE_EXTENSION）；画布五件全部
// 渲染在 App 舷窗子树内，css 收敛到 App 常驻装载后 Vite 打包零视觉变化
// （C3-C7「由所在文件 import」条款与 node 测试链冲突，修订建议记入总装 deviations）。

export interface RichDocPreviewCardProps {
  title: string;
  /** 版本胶囊原串（如「BUILD · v8」）——原样渲染，组件层不拼装不裁剪 */
  versionLabel: string;
  /** 泳道档（md/svg/pdf/unknown）——保留供选中描边等泳道语义扩展，色值走 .cvw-* */
  lane: 'md' | 'svg' | 'pdf' | 'unknown';
  /** 💡核心结论（extractCoreSummary 产物；空串时显式占位，绝不拿文件属性冒充结论） */
  conclusion: string;
  /** 前 3 行正文预览（md 正文行 / pdf 首页抽取行）；与 diffSections 二选一渲染 */
  bodyPreview?: string[];
  /** 变更章节行（kind 色与 DTM KIND_COLOR 同源令牌） */
  diffSections?: { kind: '修改' | '新增' | '删除'; title: string; line?: number }[];
  /** SVG 缩略图 dataUri（sanitizeSvgForPreview → encodeURIComponent，AtlasView 同式） */
  svgThumbDataUri?: string;
  selected?: boolean;
  /** D02 增量聚光灯：已读未变 → 低对比度背景骨架（样式走 canvasWidgets.css [data-dimmed]） */
  dimmed?: boolean;
  /** D02 增量聚光灯：当前批阅条目 → 琥珀描边行动信号（[data-spotlight-current]） */
  spotlightCurrent?: boolean;
  onClick: () => void;
  /** 双击=查看详情（v0.8 画布双击语义：打开叙事抽屉，不再直开原文） */
  onDoubleClick?: () => void;
  /** A04：右键呼出系统文件操作菜单 */
  onContextMenu?: (e: React.MouseEvent<HTMLButtonElement>) => void;
}

/** 卡片固定高（px）：PackageGroupFrame 的 foreignObject 高度按「头行 + 本高」推导，
 *  单一出处避免两处常量漂移；内容超出由 overflow hidden 收口（预览卡不做内滚动） */
export const RICH_CARD_W = 280;
export const RICH_CARD_H = 158;

/** SVG 卡与文档卡的占位句（诚实呈现：无正文/无图纸时明说，不拿元数据冒充） */
const EMPTY_CONCLUSION = '暂无正文摘要';

export default function RichDocPreviewCard({
  title,
  versionLabel,
  lane,
  conclusion,
  bodyPreview,
  diffSections,
  svgThumbDataUri,
  selected = false,
  dimmed = false,
  spotlightCurrent = false,
  onClick,
  onDoubleClick,
  onContextMenu,
}: RichDocPreviewCardProps) {
  const hasConclusion = conclusion.trim().length > 0;
  const isSvgDoc = lane === 'svg' && Boolean(svgThumbDataUri);

  return (
    <button
      type="button"
      className="cvw-rich-card"
      data-cv-rich-card
      data-lane={lane}
      data-selected={selected ? 'true' : undefined}
      data-dimmed={dimmed ? 'true' : undefined}
      data-spotlight-current={spotlightCurrent ? 'true' : undefined}
      title={`${title} · ${versionLabel}`}
      // 单击/双击先截断冒泡：卡片落在可点击的分组容器（PackageGroupFrame onSelect）内，
      // 契约 onClick 无事件参，冒泡截断收在组件内部，宿主不会收到重复触发
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      onDoubleClick={(e) => {
        e.stopPropagation();
        onDoubleClick?.();
      }}
      onContextMenu={onContextMenu}
    >
      {/* 头部：标题（truncate）+ 版本胶囊（原串透出；锚点值=versionLabel 原串） */}
      <span className="cvw-rich-card-head">
        <span className="cvw-rich-card-title">{title}</span>
        <span className="cvw-version-pill" data-cv-rich-card-version={versionLabel}>
          {versionLabel}
        </span>
      </span>

      {/* 💡核心结论行（clamp 2）——SVG 文档卡同样保留结论文本（图形文字检索摘要） */}
      <span className="cvw-rich-conclusion">
        {hasConclusion ? `💡 ${conclusion}` : `💡 ${EMPTY_CONCLUSION}`}
      </span>

      {/* 主体三态：SVG=缩略图直出；变更章节行；正文前 3 行；全空=诚实空态 */}
      {isSvgDoc ? (
        <img
          className="cvw-svg-thumb"
          src={svgThumbDataUri}
          alt={`${title} 图纸缩略图`}
          draggable={false}
        />
      ) : diffSections && diffSections.length > 0 ? (
        <span className="cvw-rich-body-list">
          {diffSections.slice(0, 3).map((section, idx) => (
            <span className="cvw-diff-row" data-kind={section.kind} key={`${section.title}-${idx}`}>
              <span className="cvw-diff-row-kind">[{section.kind}]</span>
              <span className="cvw-diff-row-title">{section.title}</span>
            </span>
          ))}
        </span>
      ) : bodyPreview && bodyPreview.length > 0 ? (
        <span className="cvw-rich-body">
          {bodyPreview.slice(0, 3).map((line, idx) => (
            <span className="cvw-rich-body-line" key={idx}>
              {line}
            </span>
          ))}
        </span>
      ) : (
        <span className="cvw-rich-empty">暂无正文预览 · 打开阅读器查看全文</span>
      )}
    </button>
  );
}
