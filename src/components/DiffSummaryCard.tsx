import React from 'react';
import { GitCompare } from 'lucide-react';
import { diffSummaryCardOf, formatDiffMetric } from '../utils/diffResultAdapter';
import type { DiffResult } from '../services/apiTypes';

/**
 * 语义 Diff 摘要卡：Agent 变更提炼——
 *   「新增交付项 (+2)、关闭未决事项 (+1)、修改接口契约 (3处)」+ 触发该版本的
 *   Checkpoint ID。数据源=任务队列口径 DiffResult（POST /diff 202 → job result）；
 *   端点不可用时 error 如实展示（本地 computeMarkdownDiff 快路径不受影响）。
 */

export interface DiffSummaryCardProps {
  result: DiffResult | null;
  loading: boolean;
  error: string | null;
  paperLightMode?: boolean;
  title?: string;
}

const DiffSummaryCard: React.FC<DiffSummaryCardProps> = ({
  result,
  loading,
  error,
  paperLightMode = true,
  title = '变更摘要',
}) => {
  const border = paperLightMode ? 'border-[#E3D9C8]' : 'border-white/[0.10]';
  const bg = paperLightMode ? 'bg-[#FBF7EF]' : 'bg-[#1D1B1A]';
  const strongInk = paperLightMode ? 'text-[#1F1E1D]' : 'text-[#F3F4F8]';
  const softInk = paperLightMode ? 'text-[#6E6A61]' : 'text-[#A5A9BC]';
  const metricInk = paperLightMode ? 'text-[#A8432F]' : 'text-[#F58C7A]';
  return (
    <div
      data-diff-summary-card=""
      className={`my-3 rounded-lg border ${border} ${bg} px-3.5 py-2.5`}
      aria-label={title}
    >
      <div className="flex flex-wrap items-center gap-2">
        <GitCompare className="w-3.5 h-3.5 shrink-0 text-[color:var(--stage-ink-exec)]" />
        <span className={`text-[length:var(--text-ui)] leading-[var(--lh-ui)] font-medium ${strongInk}`}>
          {title}
        </span>
        {loading && (
          <span className={`text-[length:var(--text-micro)] leading-[var(--lh-micro)] ${softInk}`}>
            语义摘要任务执行中（202 → 任务队列）…
          </span>
        )}
        {result && (
          <span className={`text-[length:var(--text-ui)] leading-[var(--lh-ui)] ${softInk} truncate`}>
            {result.summary.headline}
          </span>
        )}
      </div>
      {error && (
        <p className={`mt-1.5 text-[length:var(--text-micro)] leading-[var(--lh-micro)] ${softInk}`} role="status">
          语义摘要暂不可用：{error}（本地逐行对比不受影响）
        </p>
      )}
      {result && (
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 tabular-nums">
          {diffSummaryCardOf(result).metrics.map((metric) => (
            <span
              key={metric.label}
              data-diff-metric={metric.label}
              className={`text-[length:var(--text-ui)] leading-[var(--lh-ui)] ${metricInk}`}
            >
              {formatDiffMetric(metric)}
            </span>
          ))}
          {diffSummaryCardOf(result).checkpointId && (
            <span className={`text-[length:var(--text-micro)] leading-[var(--lh-micro)] font-mono ${softInk}`}>
              Checkpoint：{diffSummaryCardOf(result).checkpointId}
            </span>
          )}
        </div>
      )}
    </div>
  );
};

export default DiffSummaryCard;
