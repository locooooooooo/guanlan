

export interface RichDocPreviewCardProps {
  title: string;
  versionLabel: string;
  lane: 'md' | 'svg' | 'pdf' | 'unknown';
  conclusion: string;
  bodyPreview?: string[];
  diffSections?: { kind: '修改' | '新增' | '删除'; title: string; line?: number }[];
  svgThumbDataUri?: string;
  selected?: boolean;
  dimmed?: boolean;
  spotlightCurrent?: boolean;
  onClick: () => void;
  onDoubleClick?: () => void;
  onContextMenu?: (e: React.MouseEvent<HTMLButtonElement>) => void;
}

/** 卡片固定高（px）：PackageGroupFrame 的 foreignObject 高度按「头行 + 本高」推导，
 *  单一出处避免两处常量漂移；内容超出由 overflow hidden 收口（预览卡不做内滚动） */
export const RICH_CARD_W = 280;
export const RICH_CARD_H = 158;

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
      <span className="cvw-rich-card-head">
        <span className="cvw-rich-card-title">{title}</span>
        <span className="cvw-version-pill" data-cv-rich-card-version={versionLabel}>
          {versionLabel}
        </span>
      </span>

      <span className="cvw-rich-conclusion">
        {hasConclusion ? conclusion : EMPTY_CONCLUSION}
      </span>

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
