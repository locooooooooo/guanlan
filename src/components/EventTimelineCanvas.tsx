import { useEffect, useRef, useState } from 'react';
import * as d3 from 'd3';
import { Minus, Plus, RotateCcw } from 'lucide-react';
import { ChronosMascotNode } from './ChronosMascotNode';
import type { DocumentEvent } from '../utils/documentEvents';

export interface LinkedDocument {
  fileId: string;
  title: string;
  label: string;
}

interface Props {
  active: boolean;
  title: string;
  subtitle: string;
  nodes: DocumentEvent[];
  offset: number;
  total: number;
  selected: number | undefined;
  links: LinkedDocument[];
  onSelect: (event: DocumentEvent) => void;
  onLink: (fileId: string) => void;
  onNext: () => void;
  onRead: () => void;
}

export function EventTimelineCanvas({ title, subtitle, nodes, offset, total, selected, links, active, onSelect, onLink, onNext, onRead }: Props) {
  const svgRef = useRef<SVGSVGElement>(null);
  const worldRef = useRef<SVGGElement>(null);
  const zoomRef = useRef<d3.ZoomBehavior<SVGSVGElement, unknown> | null>(null);
  const [scale, setScale] = useState(1);
  const [positions, setPositions] = useState<Record<string, { x: number; y: number }>>({});
  const [hover, setHover] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const position = (key: string, x: number, y: number) => positions[key] ?? { x, y };
  const groupKey = nodes.map(node => node.line).join(',') + ':' + links.map(link => link.fileId).join(',');
  const trunkX = 289;
  const trunkEnd = Math.max(336, 188 + Math.ceil(nodes.length / 2) * 92);
  useEffect(() => {
    const element = svgRef.current;
    if (!element) return;
    const zoom = d3.zoom<SVGSVGElement, unknown>().scaleExtent([0.45, 2.4])
      .filter(event => event.type === 'wheel' || (!event.button && !event.target.closest('button, [data-plot-node], .d3-draggable-node')))
      .on('zoom', event => {
        worldRef.current?.setAttribute('transform', event.transform.toString());
        setScale(event.transform.k);
      });
    zoomRef.current = zoom;
    const canvas = d3.select(element).call(zoom).on('dblclick.zoom', null);
    return () => { canvas.on('.zoom', null); };
  }, []);
  useEffect(() => {
    if (!worldRef.current) return;
    const elements = d3.select(worldRef.current).selectAll<SVGGElement, unknown>('[data-plot-node]');
    const drag = d3.drag<SVGGElement, unknown>().container(() => worldRef.current!)
      .clickDistance(4).on('drag', function(event) {
        const key = this.dataset.plotNode!;
        const coord = this.transform.baseVal.consolidate()?.matrix;
        const x = coord?.e ?? 0, y = coord?.f ?? 0;
        setPositions(prev => ({ ...prev, [key]: { x: (prev[key]?.x ?? x) + event.dx, y: (prev[key]?.y ?? y) + event.dy } }));
      });
    elements.call(drag);
    return () => { elements.on('.drag', null); };
  }, [groupKey, collapsed]);
  const zoomBy = (factor: number) => {
    if (svgRef.current && zoomRef.current) d3.select(svgRef.current).call(zoomRef.current.scaleBy, factor);
  };
  const reset = () => {
    setPositions({});
    if (svgRef.current && zoomRef.current) d3.select(svgRef.current).call(zoomRef.current.transform, d3.zoomIdentity);
  };
  const curve = (y: number, x2: number, y2: number) =>
    `M ${trunkX} ${y} C ${trunkX + (x2 - trunkX) * .48} ${y}, ${x2 - (x2 - trunkX) * .3} ${y2}, ${x2} ${y2}`;
  return <div className="event-plot">
    <svg ref={svgRef} viewBox="0 0 794 640" className="event-svg" aria-label="文档事件时间轴">
      <g ref={worldRef}>
        {['var(--cv-brand)', 'var(--cv-lav)', 'var(--cv-amber)', 'var(--cv-link)'].map((color, i) =>
          <path key={color} d={`M ${trunkX - 5 + i * 3} 91 Q ${trunkX - 10 + i * 3} 260 ${trunkX - 5 + i * 3} ${trunkEnd}`} fill="none" style={{ stroke: color }} strokeWidth={3} opacity=".78"/>)}
        <foreignObject x={trunkX - 93} y={20} width={186} height={76}>
          <button className="event-hub" onClick={onRead} title={title}>
            <small>{subtitle}</small><strong>{title}</strong>
          </button>
        </foreignObject>
        <g transform="translate(55 140) scale(.86)">
          {active && <ChronosMascotNode x={0} y={0} isHovered={hover} isSelected={false} activeTimeSlice="all"
            caption={total ? '沿轴查看下一事件' : '文件关联'} onClickCycleTime={onNext}
            onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)} />}
        </g>
        <path d={curve(175,188,185)} style={{ stroke: 'var(--cv-amber)' }} strokeDasharray="4 7" fill="none" opacity=".5"/>
        {links.slice(0,3).map((link, i) => {
          const key = 'link-' + link.fileId;
          const p = position(key, 57, 365 + i * 65);
          return <g key={key}>
            <path d={curve(p.y - 22, p.x + 158, p.y + 22)} style={{ stroke: 'var(--cv-link)' }} strokeDasharray="4 5" opacity=".55" fill="none"/>
            <g data-plot-node={key} transform={`translate(${p.x} ${p.y})`}>
              <foreignObject width={158} height={52}><button className="event-link-card" title={link.title} onClick={() => onLink(link.fileId)}>
                <small>{link.label}</small><strong>{link.title}</strong>
              </button></foreignObject>
            </g>
          </g>;
        })}
        {/* 全部色值走 .dark-porthole --cv-* 令牌并挂 style（SVG 表现属性不吃 var()），
            避免纸面（xray-light）主题下容器渲染成半透明黑灰块导致按钮文字不可读 */}
        <rect x={355} y={111} width={415} height={collapsed ? 43 : Math.max(90, 55 + Math.ceil(nodes.length / 2) * 92)}
          rx={13} fillOpacity=".78" strokeDasharray="4 4"
          style={{ fill: 'var(--cv-card)', stroke: 'color-mix(in srgb, var(--cv-lav) 48%, var(--cv-trunk))' }}/>
        <foreignObject x={367} y={117} width={390} height={29}>
          <button className="event-group-button" aria-expanded={!collapsed} onClick={() => setCollapsed(!collapsed)}>
            <span>事件链 · {total} 项</span><span>{collapsed ? '展开' : '收起'}</span>
          </button>
        </foreignObject>
        {!collapsed && nodes.map((node, i) => {
          const row = Math.floor(i / 2);
          const y = 188 + row * 92;
          const key = 'event-' + node.line;
          const p = position(key, 368 + (i % 2) * 195, 154 + row * 92);
          const isSelected = selected === node.line;
          const color = isSelected ? 'var(--cv-brand)' : 'var(--cv-lav)';
          return <g key={key} pointerEvents="none">
            <path d={curve(y + (i % 2) * 9, p.x, p.y + 35)} fill="none" style={{ stroke: color }} opacity={isSelected ? .9 : .42} strokeWidth={isSelected ? 2.5 : 1.4}/>
            <circle cx={trunkX} cy={y + (i % 2) * 9} r={3.5} style={{ fill: color }}/>
            {i % 2 === 0 && <text x={trunkX - 13} y={y + 4} textAnchor="end" style={{ fill: 'var(--cv-ink-meta)' }} fontSize={10} fontFamily="var(--font-mono)">
              {node.date ?? ('L' + node.line)}
            </text>}
          </g>;
        })}
        {!collapsed && nodes.map((node, i) => {
          const key = 'event-' + node.line;
          const p = position(key, 368 + (i % 2) * 195, 154 + Math.floor(i / 2) * 92);
          const isSelected = selected === node.line;
          return <g key={key} data-plot-node={key} transform={`translate(${p.x} ${p.y})`}>
              <foreignObject width={183} height={77}>
                <button className={'event-node' + (isSelected ? ' selected' : '')} onClick={() => onSelect(node)} title={node.title}>
                  <small>{String(offset + i + 1).padStart(2, '0')} · {node.kind}
                    <span>{node.checked === undefined ? (node.children.length ? '↳ ' + node.children.length : '') : node.checked ? '已勾选' : '待处理'}</span>
                  </small>
                  <strong>{node.title}</strong>
                  <em>{node.date ? node.date + ' · ' : ''}L{node.line}{node.end !== node.line && '–' + node.end}</em>
                </button>
              </foreignObject>
          </g>;
        })}
        {!nodes.length && !collapsed && <text x={375} y={176} style={{ fill: 'var(--cv-ink-meta)' }} fontSize={12}>此处可查看原文与关联资料</text>}
      </g>
    </svg>
    <div className="event-zoom">
      <span>X-Ray</span><button aria-label="缩小画布" onClick={() => zoomBy(.85)}><Minus size={14}/></button>
      <span>{Math.round(scale * 100)}%</span><button aria-label="放大画布" onClick={() => zoomBy(1.15)}><Plus size={14}/></button>
      <button aria-label="重置画布" onClick={reset}><RotateCcw size={13}/></button>
    </div>
  </div>;
}

