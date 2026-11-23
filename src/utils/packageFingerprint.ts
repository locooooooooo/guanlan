/**
 * V07 · 专项橱窗真实数据驱动微视觉指纹（零造数纯函数层）。
 *
 * 将任意 TaskPackage + FileRecord 索引映射为三类可验证的真实数据指纹：
 * 1. 近 14 天变更微折线（Sparkline）：按本地日历日（timeFormat.localDay）统计包内真实修订次数，
 *    无变动时诚实输出全 0 基线，绝不伪造波动曲线；
 * 2. 格式构成比例彩带（Format Ribbon）：按 formatMeta.formatUiMeta 13 族语义分类聚合，
 *    严格满足 ∑segment.count === pkg.docs.length；
 * 3. 清晰更新相对时间（Updated Relative Label）：取包内最新真实 observed_at，经
 *    formatRelativeObservedAt 格式化，彻底杜绝「60...」式截断。
 */

import type { FileRecord } from '../types/guanlan';
import type { TaskPackage } from './taskPackages';
import { formatUiMeta, type FormatClass } from './formatMeta';
import { formatRelativeObservedAt, localDay } from './timeFormat';

export const PACKAGE_SPARKLINE_DAYS = 14;
export const SPARKLINE_VIEWBOX_W = 120;
export const SPARKLINE_VIEWBOX_H = 26;

export interface PackageFormatSegment {
  formatClass: FormatClass;
  label: string;
  shortTag: string;
  count: number;
  ratio: number;
  color: string;
}

export interface PackageSparkline14d {
  days: string[];
  counts: number[];
  maxCount: number;
  totalChanges: number;
  activeDays: number;
  polylinePoints: string;
  areaPoints: string;
}

export interface PackageVisualFingerprint {
  sparkline14d: PackageSparkline14d;
  formatSegments: PackageFormatSegment[];
  updatedIso: string;
  updatedRelativeLabel: string;
  docCountLabel: string;
}

const FORMAT_CLASS_SHORT_TAG: Record<FormatClass, string> = {
  markdown: 'MD',
  vector: 'SVG',
  document: 'DOC',
  code: 'CODE',
  text: 'TXT',
  image: 'IMG',
  spreadsheet: 'DATA',
  presentation: 'PPT',
  archive: 'ZIP',
  audio: 'AUD',
  video: 'VID',
  font: 'FONT',
  binary: 'BIN',
};

/** 按本地 YYYY-MM-DD 往前推 offsetDays 天（纯日历算术，不引入 UTC 日界漂移）。 */
function shiftLocalDay(anchorDay: string, offsetDays: number): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(anchorDay);
  if (!m) return anchorDay;
  const dt = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + offsetDays);
  const yyyy = dt.getFullYear();
  const mm = String(dt.getMonth() + 1).padStart(2, '0');
  const dd = String(dt.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

/** 构造近 14 天连续本地日历日键（升序：D-13 → D-0）。 */
export function buildTrailing14Days(anchorIso?: string): string[] {
  const anchorDay = localDay(anchorIso ?? new Date().toISOString());
  const days: string[] = [];
  for (let i = PACKAGE_SPARKLINE_DAYS - 1; i >= 0; i -= 1) {
    days.push(shiftLocalDay(anchorDay, -i));
  }
  return days;
}

/** 将 14 日计数序列转换为确定性 SVG 折线与面积点串（全 0 时诚实落底水平基线）。 */
export function buildSparklineGeometry(counts: readonly number[]): {
  polylinePoints: string;
  areaPoints: string;
} {
  const n = counts.length;
  const maxY = SPARKLINE_VIEWBOX_H - 2;
  const minY = 3;
  if (n === 0) {
    return {
      polylinePoints: `0,${maxY} ${SPARKLINE_VIEWBOX_W},${maxY}`,
      areaPoints: `0,${maxY} ${SPARKLINE_VIEWBOX_W},${maxY} ${SPARKLINE_VIEWBOX_W},${SPARKLINE_VIEWBOX_H} 0,${SPARKLINE_VIEWBOX_H}`,
    };
  }
  const peak = Math.max(0, ...counts);
  const stepX = n > 1 ? SPARKLINE_VIEWBOX_W / (n - 1) : SPARKLINE_VIEWBOX_W;
  const coords = counts.map((count, idx) => {
    const x = Number((idx * stepX).toFixed(1));
    const y =
      peak <= 0
        ? maxY
        : Number((maxY - (count / peak) * (maxY - minY)).toFixed(1));
    return `${x},${y}`;
  });
  const polylinePoints = coords.join(' ');
  const areaPoints = `${polylinePoints} ${SPARKLINE_VIEWBOX_W},${SPARKLINE_VIEWBOX_H} 0,${SPARKLINE_VIEWBOX_H}`;
  return { polylinePoints, areaPoints };
}

/**
 * 为单个专项包计算真实数据驱动的微视觉指纹（零造数）。
 * - nowIso 可由测试注入固定锚点时刻，保证单测 100% 确定性。
 */
export function buildPackageVisualFingerprint(
  pkg: TaskPackage,
  fileById: ReadonlyMap<string, FileRecord>,
  nowIso?: string
): PackageVisualFingerprint {
  const effectiveNowIso = nowIso ?? new Date().toISOString();
  const days = buildTrailing14Days(effectiveNowIso);
  const dayIndex = new Map<string, number>();
  days.forEach((d, idx) => dayIndex.set(d, idx));

  const counts = new Array<number>(days.length).fill(0);
  let latestIso = pkg.lastActivity || '';
  let observedAnyRevisionOrActivity = false;

  // 1. 聚合包内真实修订时间至近 14 日桶（零伪造波动）
  for (const doc of pkg.docs) {
    const file = fileById.get(doc.fileId);
    if (!file) continue;
    if (file.revisions && file.revisions.length > 0) {
      const seenRevs = new Set<string>();
      for (const rev of file.revisions) {
        if (!rev.observed_at || seenRevs.has(rev.revision_id)) continue;
        seenRevs.add(rev.revision_id);
        observedAnyRevisionOrActivity = true;
        if (!latestIso || rev.observed_at > latestIso) {
          latestIso = rev.observed_at;
        }
        const day = localDay(rev.observed_at);
        const bucketIdx = dayIndex.get(day);
        if (bucketIdx !== undefined) {
          counts[bucketIdx] += 1;
        }
      }
    }
  }

  // 若 fileById 尚未水合修订明细，但 pkg.lastActivity 落在 14 日内，诚实计入该日 1 次已知动态
  if (!observedAnyRevisionOrActivity && pkg.lastActivity) {
    const day = localDay(pkg.lastActivity);
    const bucketIdx = dayIndex.get(day);
    if (bucketIdx !== undefined) {
      counts[bucketIdx] += Math.max(1, pkg.eventCount > 0 ? 1 : 1);
    }
  }

  const maxCount = counts.reduce((acc, c) => (c > acc ? c : acc), 0);
  const totalChanges = counts.reduce((acc, c) => acc + c, 0);
  const activeDays = counts.filter((c) => c > 0).length;
  const { polylinePoints, areaPoints } = buildSparklineGeometry(counts);

  // 2. 格式构成比例彩带（严格消费 formatUiMeta SSOT，守恒 ∑count === pkg.docs.length）
  const formatBucket = new Map<
    FormatClass,
    { label: string; shortTag: string; count: number; color: string }
  >();
  for (const doc of pkg.docs) {
    const meta = formatUiMeta(doc.format);
    const prev = formatBucket.get(meta.formatClass);
    if (prev) {
      prev.count += 1;
    } else {
      formatBucket.set(meta.formatClass, {
        label: meta.classLabel,
        shortTag: FORMAT_CLASS_SHORT_TAG[meta.formatClass] ?? meta.label.toUpperCase(),
        count: 1,
        color: meta.dotColor,
      });
    }
  }
  const totalDocs = pkg.docs.length;
  const formatSegments: PackageFormatSegment[] = Array.from(formatBucket.entries())
    .map(([formatClass, item]) => ({
      formatClass,
      label: item.label,
      shortTag: item.shortTag,
      count: item.count,
      ratio: totalDocs > 0 ? item.count / totalDocs : 0,
      color: item.color,
    }))
    .sort((a, b) => b.count - a.count || a.formatClass.localeCompare(b.formatClass));

  // 3. 清晰更新相对时间（无有效时间戳时诚实显示「待更新」，杜绝假时间）
  const updatedRelativeLabel = latestIso
    ? formatRelativeObservedAt(latestIso)
    : '待更新';

  return {
    sparkline14d: {
      days,
      counts,
      maxCount,
      totalChanges,
      activeDays,
      polylinePoints,
      areaPoints,
    },
    formatSegments,
    updatedIso: latestIso,
    updatedRelativeLabel,
    docCountLabel: `${totalDocs} 份`,
  };
}
