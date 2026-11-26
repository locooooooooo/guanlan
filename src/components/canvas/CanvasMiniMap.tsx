
import React, { useCallback, useRef } from 'react';

export interface CanvasMiniMapProps {
  worldWidth: number;
  worldHeight: number;
  viewport: { x: number; y: number; width: number; height: number };
  onJump: (x: number, y: number) => void;
  className?: string;
}

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
          x: (160 - worldWidth * fitScale) / 2,
          y: (100 - worldHeight * fitScale) / 2,
        }
      : null;

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
