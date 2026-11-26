
import React from 'react';
import type { StageRole } from '../../utils/taskPackages';
import { RICH_CARD_H } from './RichDocPreviewCard';

export interface PackageGroupFrameProps {
  pkgId: string;
  name: string;
  docCount: number;
  stage: StageRole;
  x: number;
  y: number;
  width: number;
  collapsed?: boolean;
  selected?: boolean;
  onSelect?: () => void;
  titleAsOverlay?: boolean;
  children: React.ReactNode;
}

/** 容器头行高（px）+ 上下内边距：foreignObject 高 = 12(上 padding) + 头行 20 + 间距 8 + 卡高 + 14(下 padding) */
export const PACKAGE_GROUP_FRAME_H = 12 + 20 + 8 + RICH_CARD_H + 14;

const stageDotTone = (stage: StageRole): 'amber' | 'lav' | 'neutral' => {
  if (stage === '执行' || stage === '交付') return 'amber';
  if (stage === '待分类') return 'neutral';
  return 'lav';
};

export default function PackageGroupFrame({
  pkgId,
  name,
  docCount,
  stage,
  x,
  y,
  width,
  collapsed = false,
  selected = false,
  onSelect,
  titleAsOverlay = false,
  children,
}: PackageGroupFrameProps) {
  return (
    <foreignObject x={x} y={y} width={Math.max(0, width)} height={PACKAGE_GROUP_FRAME_H}>
      <div
        className="cvw-package-frame"
        data-cv-package-group={pkgId}
        data-selected={selected ? 'true' : undefined}
        onClick={onSelect}
      >
        <div className="cvw-package-frame-head">
          <span className="cvw-stage-dot" data-tone={stageDotTone(stage)} title={`阶段：${stage}`} />
          <span
            className="cvw-package-frame-name"
            title={name}
            style={titleAsOverlay ? { visibility: 'hidden' } : undefined}
          >
            {name}
          </span>
          <span
            className="cvw-package-frame-count"
            style={titleAsOverlay ? { visibility: 'hidden' } : undefined}
          >
            {docCount} 份
          </span>
        </div>
        {collapsed ? null : <div className="cvw-package-frame-cards">{children}</div>}
      </div>
    </foreignObject>
  );
}
