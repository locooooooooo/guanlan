/**
 * 画布右上角缩略小地图。
 *
 * world = zoom 层内容包围盒（宿主收集节点/扇出盒/分组横排计算），viewport = 当前
 * transform 折算的用户空间可视矩形；点击/拖框跳转走宿主既有运镜
 * （PAN_TRANSITION_MS=500=--dur-pan）。
 * 锚点：data-cv-minimap（容器）、data-cv-minimap-viewport（视口框）。
 * 舷窗纪律：样式全走 .cvw-*，零内联色值；位置类由宿主 className 注入
 * （right-4 top-3 z-20，约 160×100px）。
 */

import React, { useCallback, useRef } from 'react';
// 样式文件统一由 App.tsx 装载：Node 测试链不解析 .css 导入，由 App 常驻装载兜底

export interface CanvasMiniMapProps {
  worldWidth: number;
  worldHeight: number;
  /** 当前可视矩形（zoom 层用户空间）：x/y=左上角，width/height=可视宽高 */
  viewport: { x: number; y: number; width: number; height: number };
  /** 跳转到世界坐标 (x, y)（宿主实现：把该点运镜到可视区中心） */
  onJump: (x: number, y: number) => void;
  className?: string;
}

/** 地图内边距（px）：世界框与容器边缘的呼吸位 */
const MAP_PAD = 8;

export default function CanvasMiniMap({
  worldWidth,
  worldHeight,
  viewport,
  onJump,
  className,
}: CanvasMiniMapProps) {
  const mapRef = useRef<HTMLDivElement | null>(null);
  const draggingRef = useRef(false);

  // 世界 → 地图坐标：等比缩放居中（worldWidth/Height ≤ 0 时全框退化，视口框隐藏）
  const fitScale =
    Number.isFinite(worldWidth) &&
    Number.isFinite(worldHeight) &&
    worldWidth > 0 &&
    worldHeight > 0
      ? Math.min(
          (160 - MAP_PAD * 2) / worldWidth,
          (100 - MAP_PAD * 2) / worldHeight
        )
      : 0;
  const worldBox =
    fitScale > 0
      ? {
          w: worldWidth * fitScale,
          h: worldHeight * fitScale,
          // 居中留白：世界比容器「矮胖/瘦高」时往中间靠
          x: (160 - worldWidth * fitScale) / 2,
          y: (100 - worldHeight * fitScale) / 2,
        }
      : null;

  /** 地图本地坐标 → 世界坐标 */
  const toWorld = useCallback(
    (localX: number, localY: number): { x: number; y: number } | null => {
      if (!worldBox) return null;
      return {
        x: (localX - worldBox.x) / fitScale,
        y: (localY - worldBox.y) / fitScale,
      };
    },
    [worldBox, fitScale]
  );

  const jumpFromEvent = useCallback(
    (clientX: number, clientY: number) => {
      const el = mapRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const world = toWorld(clientX - rect.left, clientY - rect.top);
      if (world) onJump(world.x, world.y);
    },
    [onJump, toWorld]
  );

  // 点击/拖框跳转：pointerdown 即跳并捕获，pointermove 跟手连续跳（运镜由宿主收口）
  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    draggingRef.current = true;
    e.currentTarget.setPointerCapture(e.pointerId);
    jumpFromEvent(e.clientX, e.clientY);
  };
  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return;
    jumpFromEvent(e.clientX, e.clientY);
  };
  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    draggingRef.current = false;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  };

  // 视口框（世界坐标 → 地图坐标）：越界部分被容器 overflow hidden 收口，不钳制
  const viewportBox =
    worldBox &&
    Number.isFinite(viewport.x) &&
    Number.isFinite(viewport.y) &&
    viewport.width > 0 &&
    viewport.height > 0
      ? {
          left: worldBox.x + viewport.x * fitScale,
          top: worldBox.y + viewport.y * fitScale,
          width: viewport.width * fitScale,
          height: viewport.height * fitScale,
        }
      : null;

  return (
    <div
      ref={mapRef}
      className={`cvw-minimap ${className ?? ''}`}
      data-cv-minimap
      role="img"
      aria-label="画布小地图：点击跳转到对应区域"
      title="画布小地图 · 点击或拖动跳转"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
    >
      {worldBox && (
        <span
          className="cvw-minimap-world"
          style={{
            left: worldBox.x,
            top: worldBox.y,
            width: worldBox.w,
            height: worldBox.h,
          }}
        />
      )}
      {viewportBox && (
        <span
          className="cvw-minimap-viewport"
          data-cv-minimap-viewport
          style={{
            left: viewportBox.left,
            top: viewportBox.top,
            width: viewportBox.width,
            height: viewportBox.height,
          }}
        />
      )}
    </div>
  );
}
