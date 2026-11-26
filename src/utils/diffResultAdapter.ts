
import type { DiffResult, DiffSummaryMetric } from '../services/apiTypes';

export interface DiffSummaryCardVM {
  headline: string;
  metrics: DiffSummaryMetric[];
  checkpointId: string | null;
}

/** 服务端指标缺失时的三项兜底（count=0，不造假数值） */
export const DIFF_FALLBACK_METRICS: readonly DiffSummaryMetric[] = [
  { label: '新增交付项', count: 0, sign: '+' },
  { label: '关闭未决事项', count: 0, sign: '-' },
  { label: '修改接口契约', count: 0, sign: '~' },
];

/**
 * DiffResult → 摘要卡视图模型：headline 空值兜底；items 空时给三项 0 值兜底
 * （保持三指标卡面形状，绝不编造计数）；checkpoint_id 逐字透传（标注触发
 * 该版本生成的具体任务 Checkpoint ID，后端未给时 null）。
 */
export function diffSummaryCardOf(result: DiffResult): DiffSummaryCardVM {
  const metrics =
    result.summary.items && result.summary.items.length > 0
      ? result.summary.items
      : [...DIFF_FALLBACK_METRICS];
  return {
    headline: result.summary.headline?.trim() || '语义变更摘要',
    metrics,
    checkpointId: result.summary.checkpoint_id ?? null,
  };
}

/** 单指标格式化文案：sign='+' →「+2 新增交付项」；'~' →「3 处修改接口契约」 */
export function formatDiffMetric(metric: DiffSummaryMetric): string {
  if (metric.sign === '~') return `${metric.count} 处${metric.label}`;
  const sign = metric.sign === '+' ? `+${metric.count}` : `${metric.count}`;
  return `${sign} ${metric.label}`;
}
