/**
 * 观澜 Guanlan —— Markdown 章节大纲解析
 *
 * v0.3 的扫描→转换链（extractDecisions / extractRelations / buildTimelineEvents /
 * buildWorkspaceState）已随 v0.4 采集对账链（collectWorkspace + server/reconcile）
 * 下线删除，本模块仅保留仍在使用的章节大纲解析。
 */

import type { MarkdownSection } from '../types/guanlan';

/**
 * 从 Markdown 提取章节大纲（跳过代码块）
 */
export function parseMarkdownOutline(markdown: string): MarkdownSection[] {
  const lines = markdown.split('\n');
  const sections: MarkdownSection[] = [];
  let inFence = false;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (raw.trim().startsWith('```')) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    const m = /^(#{1,3})\s+(.+)$/.exec(raw.trim());
    if (!m) continue;

    if (sections.length > 0) sections[sections.length - 1].endLine = i;
    const title = m[2].trim();
    sections.push({
      id: title,
      title,
      level: m[1].length as 1 | 2 | 3,
      startLine: i + 1,
      endLine: lines.length,
    });
  }
  return sections;
}
