/**
 * 观澜 Guanlan —— Markdown 章节大纲解析（Node 对拍基线）
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
