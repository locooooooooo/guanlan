/**
 * 纯展示态文本清洗：只作用于卡片标题/摘要预览层，不改底层存储与检索原文。
 * 去除从 Markdown 表格/加粗/行内代码中抽取出的原始标记符（`**`、`` ` ``、`|` 等），
 * 避免星图节点、决策雷达、时间线与首页焦点卡裸露 Markdown 源码噪声。
 */
export function cleanDisplayText(raw: string | null | undefined): string {
  if (!raw) return '';
  return raw
    // Markdown 链接 `[文本](url)` → 保留可见文本
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    // 粗体 / 斜体 / 删除线标记
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/~~(.+?)~~/g, '$1')
    // 残余成对或孤立的反引号、星号
    .replace(/`+/g, '')
    .replace(/\*{2,}/g, '')
    // 表格竖线分隔符收敛为中文顿点分隔
    .replace(/\s*\|\s*/g, ' · ')
    // 清除行首/行尾残留分隔符与多余空白
    .replace(/^[·\s:：-]+/, '')
    .replace(/\s+/g, ' ')
    .trim();
}
