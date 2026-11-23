/**
 * v0.8 任务空间桌面 · 任务包分组容器（R1 / 组件契约 C3）。
 *
 * 形态：foreignObject HTML 容器，落在 GraphCanvasView 的 zoom 层内；主场景按焦点
 * 任务包横向排布，容器内横排承载 RichDocPreviewCard（children）。
 * 分组语义（L1 层）：bg var(--cv-slot)、圆角 16px、无边框无阴影——层级只由底色阶
 * 表达（浅灰分组语义，R1 硬规定）。
 * 容器头 = 包名 + 文档数 + 阶段点（--cv-amber/--cv-lav 图形档双色：执行/交付=amber
 * 落地热区，蓝图/计划/决策=lav 规划冷区，待分类=中性）。
 *
 * 实现注记（契约 props 无 height 字段）：foreignObject 必须显式高度才能布下 HTML，
 * 本组件以「头行 + 单行富预览卡」推导（RICH_CARD_H 单一出处），由 GCV 布局层同源
 * 消费 PACKAGE_GROUP_FRAME_H 计算横排几何——两常量不得各自手改。
 * 舷窗纪律：样式全走 .cvw-*（canvasWidgets.css），本文件零内联色值。
 */

import React from 'react';
import type { StageRole } from '../../utils/taskPackages';
import { RICH_CARD_H } from './RichDocPreviewCard';
// css 装载上移 App.tsx（总装，指挥授权）：node --test/tsx 测试链加载不了 .css 扩展名，
// 组件内 import 会让 gc-12/wf2/canvas-theme 文件级失败；由 App 常驻装载兜底，零视觉变化

export interface PackageGroupFrameProps {
  pkgId: string;
  name: string;
  docCount: number;
  stage: StageRole;
  x: number;
  y: number;
  width: number;
  /** 折叠态（仅出容器头行；横排主场景当前恒展开，prop 保留供后续收起交互） */
  collapsed?: boolean;
  selected?: boolean;
  onSelect?: () => void;
  /** D01-a ③：标题已升 Overlay 屏幕空间恒定像素字号层——本 foreignObject 头行
   *  只保留 dot（图形档，缩放不糊文字）并让 name/count 占位不绘制（visibility，
   *  布局零位移），绘制职责移交 Overlay 层。缺省 false = 旧行为（测试/独立渲染）。 */
  titleAsOverlay?: boolean;
  children: React.ReactNode;
}

/** 容器头行高（px）+ 上下内边距：foreignObject 高 = 12(上 padding) + 头行 20 + 间距 8 + 卡高 + 14(下 padding) */
export const PACKAGE_GROUP_FRAME_H = 12 + 20 + 8 + RICH_CARD_H + 14;

/** StageRole → 阶段点图形档（--cv-amber/--cv-lav 图形档双色映射；待分类走中性） */
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
      {/* 容器根可点（ onSelect ）；卡面自身点击不冒泡到 onSelect——卡片 onClick 自行 stopPropagation */}
      <div
        className="cvw-package-frame"
        data-cv-package-group={pkgId}
        data-selected={selected ? 'true' : undefined}
        onClick={onSelect}
      >
        <div className="cvw-package-frame-head">
          <span className="cvw-stage-dot" data-tone={stageDotTone(stage)} title={`阶段：${stage}`} />
          {/* D01-a ③：titleAsOverlay 时 name/count 只占位不绘制（visibility 保布局），
              文字由 Overlay 屏幕空间层恒定像素字号绘制（缩放不模糊、随容器宽自动省略） */}
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
