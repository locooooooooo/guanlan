/**
 * 阅读器局部关系图面板：
 * 提供一跳/二跳切换、非重叠列布局 SVG 与关系证据明细。
 */

import React from 'react';
import { Button } from '../ui/primitives';
import type { ReaderCtx } from './useReaderController';

export function ReaderRelationsSection({ ctx }: { ctx: ReaderCtx }) {
  const {
    subMode,
    paperLightMode,
    activeFile,
    graphHopDepth,
    setGraphHopDepth,
    localGraph,
    onNavigateLinkedFile,
    currentRev,
    onSelectDecision,
  } = ctx;
  if (subMode !== 'relations') return null;
  return (
    <div
      className={`flex-1 overflow-y-auto p-6 space-y-5 ${
        paperLightMode
          ? 'bg-[#FAF9F5] text-[#1F1E1D]'
          : 'bg-[#1A1917] text-[#F4F3EE]'
      }`}
    >
      <div className="max-w-5xl mx-auto space-y-4">
        <div
          className={`flex flex-wrap items-center justify-between gap-4 p-4 rounded-lg border ${
            paperLightMode
              ? 'bg-white/60 border-[color:var(--glass-hairline)]'
              : 'bg-white/60 border-[color:var(--glass-hairline)]'
          }`}
        >
          <div>
            <h2
              className={`text-sm font-semibold ${
                paperLightMode
                  ? 'text-[color:var(--ink-strong)]'
                  : 'text-[color:var(--ink-strong)]'
              }`}
            >
              局部关系视图 · 以「{activeFile.title}」为中心
            </h2>
            <p
              className="text-xs mt-0.5 text-[color:var(--ink-soft)]"
            >
              关系图服务于选下一份材料，不替代正文阅读。实线表示显式引用、版本演进或明确决策依据；虚线表示同主题/同任务号分组关联。
            </p>
          </div>

          <div className="flex items-center gap-2 text-xs">
            <Button
              variant={graphHopDepth === 1 ? 'primary' : 'ghost'}
              size="sm"
              onClick={() => setGraphHopDepth(1)}
            >
              默认一跳 (1-Hop)
            </Button>
            <Button
              variant={graphHopDepth === 2 ? 'primary' : 'ghost'}
              size="sm"
              onClick={() => setGraphHopDepth(2)}
              disabled={!localGraph.canExpandTwoHop && graphHopDepth === 1}
            >
              展开二跳 (2-Hop)
            </Button>
          </div>
        </div>

        {/* Interactive SVG Graph Visualization */}
        <div
          className={`rounded-lg border p-4 ${
            paperLightMode ? 'border-[#E3E0D8]' : 'border-[#383633]'
          }`}
        >
          <svg
            viewBox="0 0 920 420"
            className="w-full h-96 bg-[#1A1917] rounded border border-[#383633]"
            role="img"
            aria-label="局部对象一跳与二跳关系图"
          >
            {/* Structured Non-Overlapping Column Layout: Left (Revisions & Decisions) | Center (Selected Object) | Right (Referenced Files & 2-Hop) */}
            {(() => {
              const center = localGraph.nodes.find((n) => n.hop === 0);
              const leftNodes = localGraph.nodes.filter(
                (n) => n.hop > 0 && (n.kind === 'revision' || n.kind === 'decision')
              );
              const rightNodes = localGraph.nodes.filter(
                (n) => n.hop > 0 && n.kind === 'file'
              );
              const positions = new Map<string, { x: number; y: number }>();
              if (center) positions.set(center.id, { x: 460, y: 210 });

              leftNodes.forEach((n, idx) => {
                const stepY = 360 / Math.max(1, leftNodes.length);
                positions.set(n.id, {
                  x: 155,
                  y: Math.round(45 + idx * stepY + stepY / 2 - 20),
                });
              });

              rightNodes.forEach((n, idx) => {
                const stepY = 360 / Math.max(1, rightNodes.length);
                positions.set(n.id, {
                  x: n.hop === 2 ? 790 : 750,
                  y: Math.round(45 + idx * stepY + stepY / 2 - 20),
                });
              });

              return (
                <>
                  {/* Edges */}
                  {localGraph.edges.map((edge) => {
                    const p1 = positions.get(edge.source_id);
                    const p2 = positions.get(edge.target_id);
                    if (!p1 || !p2) return null;
                    const midX = (p1.x + p2.x) / 2;
                    const midY = (p1.y + p2.y) / 2;
                    return (
                      <g key={edge.edge_id}>
                        <line
                          x1={p1.x}
                          y1={p1.y}
                          x2={p2.x}
                          y2={p2.y}
                          stroke={
                            edge.isInferred
                              ? '#f59e0b'
                              : edge.type === 'decision_basis'
                                ? '#38bdf8'
                                : '#64748b'
                          }
                          strokeWidth={edge.isInferred ? 1.5 : 2}
                          strokeDasharray={edge.isInferred ? '6,4' : undefined}
                        />
                        <text
                          x={midX}
                          y={midY - 6}
                          fill="#94a3b8"
                          fontSize="10"
                          textAnchor="middle"
                        >
                          {edge.label}
                        </text>
                      </g>
                    );
                  })}

                  {/* Nodes */}
                  {localGraph.nodes.map((node) => {
                    const pos = positions.get(node.id);
                    if (!pos) return null;
                    const isCenter = node.hop === 0;
                    return (
                      <g
                        key={node.id}
                        transform={`translate(${pos.x - 85}, ${pos.y - 24})`}
                        className="cursor-pointer"
                        onClick={() => {
                          if (node.kind === 'file' && node.id !== activeFile.file_id) {
                            onNavigateLinkedFile(node.id, {
                              fileId: activeFile.file_id,
                              revisionId: currentRev.revision_id,
                              title: activeFile.title,
                            });
                          } else if (node.kind === 'decision') {
                            onSelectDecision(node.id);
                          }
                        }}
                      >
                        <rect
                          width="170"
                          height="48"
                          rx="8"
                          fill={
                            isCenter
                              ? '#0284c7'
                              : node.kind === 'decision'
                                ? '#451a03'
                                : '#1e293b'
                          }
                          stroke={
                            isCenter
                              ? '#7dd3fc'
                              : node.kind === 'decision'
                                ? '#f59e0b'
                                : '#475569'
                          }
                          strokeWidth={isCenter ? '2' : '1.5'}
                        />
                        <text
                          x="85"
                          y="20"
                          fill="#f8fafc"
                          fontSize="11"
                          fontWeight="600"
                          textAnchor="middle"
                        >
                          {node.label.slice(0, 16)}
                        </text>
                        <text
                          x="85"
                          y="36"
                          fill={isCenter ? '#e0f2fe' : '#94a3b8'}
                          fontSize="9.5"
                          textAnchor="middle"
                        >
                          {node.subLabel.slice(0, 22)}
                        </text>
                      </g>
                    );
                  })}
                </>
              );
            })()}
          </svg>

          {/* Explicit Relation Evidence List */}
          <div className="mt-4 space-y-2">
            <div
              className={`text-xs font-semibold ${
                paperLightMode ? 'text-[#1F1E1D]' : 'text-[#F4F3EE]'
              }`}
            >
              关系证据与方向明细（共 {localGraph.edges.length} 条连线 · 节点上限 80）：
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
              {localGraph.edges.map((edge) => (
                <div
                  key={edge.edge_id}
                  className={`p-2.5 rounded border text-xs flex flex-col gap-1 ${
                    paperLightMode
                      ? 'bg-white/60 border-[color:var(--glass-hairline)]'
                      : 'bg-white/60 border-[color:var(--glass-hairline)]'
                  }`}
                  /* 端点 ID 放入卡片 title 供调试核对，不占正文版面 */
                  title={`${edge.source_id} → ${edge.target_id}`}
                >
                  <div className="flex items-center justify-between">
                    <span
                      className={`font-semibold ${
                        paperLightMode ? 'text-[#9A6A45]' : 'text-[#D99B52]'
                      }`}
                    >
                      {edge.label} ({edge.isInferred ? '虚线推断/同组' : '实线显式证据'})
                    </span>
                    {/* 等宽位显示「原文 L{n}」；locator 缺省时整行不渲染，
                        避免与下方已渲染的 {edge.reason} 重复 */}
                    {edge.locator && (
                      <span
                        className="font-mono text-[length:var(--text-micro)] leading-[var(--lh-micro)] tabular-nums text-[color:var(--ink-soft)]"
                      >
                        原文 L{edge.locator.startLine}
                      </span>
                    )}
                  </div>
                  <p
                    className={
                      paperLightMode
                        ? 'text-[color:var(--ink-soft)]'
                        : 'text-[color:var(--ink-soft)]'
                    }
                  >
                    {edge.reason}
                  </p>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

