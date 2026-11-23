/**
 * D01-a 拆解 · 阅读器渲染期闭包层（自 useReaderController.tsx 自包含块原样迁入，
 * 行数护栏）：行模型 → JSX 的全部渲染期叠加函数（inline tokens/链接分段/行锚
 * 包装/决策回执可交互行/行模型分支渲染）。易变态经显式参数传入（与拆解前闭包
 * 捕获同一批值），解析已前移到 buildMarkdownBlocks。
 */

import React from 'react';
import { formatOfficeAnchorLabel } from '../../utils/officeAnchor';
import { formatPdfAnchorLabel } from '../../utils/pdfAnchor';
import {
  buildLinkParts,
  type InlineToken,
  type LinkPart,
  type MarkdownBlock,
  type MarkdownLinkIndex,
} from './readerMarkdownModel';
import {
  fillPromptOf,
  type DecisionFormItem,
} from './readerDecisionModel';
import type { ReaderAnnotation } from '../../utils/readerAnnotations';
import type { FileRecord } from '../../types/guanlan';

interface ReaderRenderInputs {
  paperLightMode: boolean;
  sourceLine?: number;
  /** D04：反向定位闪烁行（决定跳转到达/GU-CC-01 回退落点/批注定位），2.2s 自动摘除 */
  flashSourceLine?: number;
  /** D04：本版本 MD 行批注索引（wrapLine 渲染批注徽标） */
  annotationsByLine: Map<number, ReaderAnnotation[]>;
  /** D04：块悬停「批注」入口（打开撰写卡） */
  onAnnotateBlock: (line: number, excerpt: string) => void;
  /** D04：批注徽标点击 → 打开批注清单 */
  onOpenAnnotations: () => void;
  showLineNumbers: boolean;
  activeSectionId: string;
  activeFile: FileRecord;
  currentRev: FileRecord['revisions'][number];
  receiptState: { key: string; checks: Record<string, boolean>; fills: Record<string, string> } | null;
  receiptStorageKey: string;
  decisionFormItems: Map<number, DecisionFormItem>;
  markdownLinkIndex: MarkdownLinkIndex;
  markdownScrollRef: React.MutableRefObject<HTMLDivElement | null>;
  onNavigateLinkedFile: (
    targetFileId: string,
    returnOrigin: { fileId: string; revisionId: string; sectionId?: string; title: string },
    officeAnchor?: import('../../types/guanlan').OfficeEvidenceAnchor,
    pdfAnchor?: import('../../types/guanlan').PdfEvidenceAnchor
  ) => void;
  onMarkReadHere: (fileId: string, revisionId: string, sectionId?: string) => void;
  readingState?: import('../../types/guanlan').ReadingState;
  handleAddSectionToContext: (
    startLine: number,
    endLine: number,
    excerptText: string,
    noteText?: string
  ) => void;
  toggleDecisionCheck: (line: number) => void;
  setDecisionFillValue: (slotKey: string, value: string) => void;
}

export function useReaderRender({
  paperLightMode,
  sourceLine,
  flashSourceLine,
  annotationsByLine,
  onAnnotateBlock,
  onOpenAnnotations,
  showLineNumbers,
  activeSectionId,
  activeFile,
  currentRev,
  receiptState,
  receiptStorageKey,
  decisionFormItems,
  markdownLinkIndex,
  markdownScrollRef,
  onNavigateLinkedFile,
  onMarkReadHere,
  readingState,
  handleAddSectionToContext,
  toggleDecisionCheck,
  setDecisionFillValue,
}: ReaderRenderInputs) {


  // ── 渲染期叠加层（perf②）：以下全部只消费行模型 + 当前易变态，不再做任何
  // 字符串解析/链接解析；解析已前移到 buildMarkdownBlocks（useMemo）。易变输入
  // （paperLightMode / sourceLine / showLineNumbers / activeSectionId / readingState /
  // 各回调）在此处读取最新值，保证 className/onClick/高亮与旧版逐字一致且永不取旧。

  // Format inline **bold** and `code` tokens inside plain text segments
  // （渲染期回放 tokenizeInline 的切分结果；键方案 seg-{prefix}-b/c-{偏移} 沿用旧版）
  const renderInlineTokens = (tokens: import('./readerMarkdownModel').InlineToken[], keyPrefix: string): React.ReactNode => {
    // 旧版对空片段返回原字符串（空串节点）；tokenizeInline 空切分 ⇔ 空片段
    if (tokens.length === 0) return '';
    const nodes: React.ReactNode[] = [];
    for (const token of tokens) {
      if (token.kind === 'plain') {
        nodes.push(token.text);
      } else if (token.kind === 'bold') {
        nodes.push(
          <strong key={`${keyPrefix}-b-${token.at}`} className="font-semibold">
            {token.text}
          </strong>
        );
      } else {
        nodes.push(
          <code
            key={`${keyPrefix}-c-${token.at}`}
            className={`px-1 py-0.5 rounded font-mono text-[0.88em] ${
              paperLightMode
                ? 'bg-[#EFEAE0] text-[#9A5B33]'
                : 'bg-[#302E2B] text-[#D99B52]'
            }`}
          >
            {token.text}
          </code>
        );
      }
    }
    return nodes;
  };

  // Resolve relative links inside Markdown lines ([label](relative-path))
  // （渲染期回放 buildLinkParts 的分段结果：目标已在模型期解析，导航闭包在此用
  // 最新 activeSectionId/currentRev 构建，永不取旧）
  const renderLinkParts = (parts: LinkPart[], sectionHint?: string): React.ReactNode[] => {
    const nodes: React.ReactNode[] = [];
    for (const part of parts) {
      if (part.kind === 'inline') {
        nodes.push(renderInlineTokens(part.tokens, part.key));
      } else if (part.target) {
        const targetFile = part.target;
        const anchorTag = part.officeAnchor
          ? formatOfficeAnchorLabel(part.officeAnchor)
          : part.pdfAnchor
            ? formatPdfAnchorLabel(part.pdfAnchor)
            : '';
        nodes.push(
          <button
            key={part.key}
            type="button"
            onClick={() =>
              onNavigateLinkedFile(
                targetFile.file_id,
                {
                  fileId: activeFile.file_id,
                  revisionId: currentRev.revision_id,
                  sectionId: sectionHint || activeSectionId || '正文段落',
                  title: activeFile.title,
                },
                part.officeAnchor,
                part.pdfAnchor
              )
            }
            className={`inline-flex items-center gap-1 font-medium underline underline-offset-4 mx-0.5 transition-colors ${
              paperLightMode
                ? 'text-[#9A6A45] hover:text-[#7C5436] decoration-[#D8B79B]'
                : 'text-[#D99B52] hover:text-[#E5B071] decoration-[#8A6A4F]'
            }`}
          >
            <span>{part.label}</span>
            <span className="text-[length:var(--text-micro)] leading-[var(--lh-micro)] font-mono text-[#8A857C]">
              [{targetFile.format.toUpperCase()}
              {anchorTag ? ` · ${anchorTag}` : ''}]
            </span>
          </button>
        );
      } else {
        const cleanLabel = part.label.replace(/`+/g, '').trim();
        const showHref = Boolean(part.href && cleanLabel !== part.href);
        nodes.push(
          <span
            key={part.key}
            className={`inline-flex items-baseline gap-1 whitespace-nowrap rounded px-1 py-0.5 font-mono text-[0.86em] underline decoration-dotted underline-offset-2 ${
              paperLightMode
                ? 'bg-[#F5EFE6] text-[#9A5B33] decoration-[#C99B72]'
                : 'bg-[#282420] text-[#E3A963] decoration-[#8A6A4F]'
            }`}
            title={`未解析链接: ${part.href}`}
          >
            <span>{cleanLabel || part.label}</span>
            {showHref && <span className="opacity-70 text-[0.9em]">({part.href})</span>}
          </span>
        );
      }
    }
    return nodes;
  };

  // 行锚包装（原解析 IIFE 内的 wrapLine 原样提升）：data-event-source-line 粒度、
  // sourceLine 高亮 style、showLineNumbers 行号位、+引用此段按钮全部在渲染期叠加。
  // D04 叠加：批注徽标（有批注的行常驻琥珀便签数标，点击开清单）+「批注」悬停钮
  // （打开撰写卡）+ 反向定位闪烁类（flashSourceLine 到达两轮脉冲，2.2s 后摘除）。
  const wrapLine = (
    lineNum: number,
    node: React.ReactNode,
    excerptForCopy?: string
  ) => {
    const lineAnnotations = annotationsByLine.get(lineNum);
    return (
      <div
        key={lineNum}
        data-event-source-line={lineNum}
        data-flash-anchor={lineNum === flashSourceLine ? String(lineNum) : undefined}
        style={lineNum === sourceLine ? { outline: '2px solid #9b8afb', outlineOffset: '2px' } : undefined}
        className={`group relative flex items-baseline gap-3 rounded px-1 -mx-1 transition-colors ${
          lineNum === flashSourceLine ? 'glx-anchor-flash' : ''
        } ${
          paperLightMode ? 'hover:bg-[#1F1E1D]/[0.04]' : 'hover:bg-white/[0.04]'
        }`}
      >
        {showLineNumbers && (
          <span
            className={`w-9 shrink-0 text-right font-mono text-xs select-none tabular-nums ${
              paperLightMode ? 'text-[#8A857C]' : 'text-[#6E6D68]'
            }`}
          >
            L{lineNum}
          </span>
        )}
        <div className="flex-1 min-w-0">{node}</div>
        {lineAnnotations && (
          <button
            type="button"
            onClick={onOpenAnnotations}
            data-block-annotation-badge={lineAnnotations.length}
            title={`本行有 ${lineAnnotations.length} 条本地批注，点击打开批注清单`}
            className="shrink-0 self-center flex items-center gap-0.5 text-[11px] font-sans px-1.5 py-0.5 rounded text-[#9A6A45] dark:text-[#E5A96A] bg-[#FBF3E4] dark:bg-[#3A322A] opacity-80 hover:opacity-100 transition-opacity"
          >
            ✎ {lineAnnotations.length}
          </button>
        )}
        {excerptForCopy && excerptForCopy.length > 8 && (
          <>
            <button
              type="button"
              onClick={() => onAnnotateBlock(lineNum, excerptForCopy)}
              className={`opacity-0 group-hover:opacity-100 transition-opacity text-[11px] font-sans px-2 py-0.5 rounded shrink-0 ${
                paperLightMode
                  ? 'bg-[#EFE4D5] text-[#9A6A45] hover:bg-[#E8DCC8]'
                  : 'bg-[#3A322A] text-[#D99B52]'
              }`}
              title="为该段落添加本地批注（按版本哈希绑定，不改原文）"
            >
              批注
            </button>
            <button
              type="button"
              onClick={() =>
                handleAddSectionToContext(
                  lineNum,
                  lineNum + 2,
                  excerptForCopy,
                  `行段引用 L${lineNum}`
                )
              }
              className={`opacity-0 group-hover:opacity-100 transition-opacity text-[11px] font-sans px-2 py-0.5 rounded shrink-0 ${
                paperLightMode
                  ? 'bg-[#EFE4D5] text-[#9A6A45] hover:bg-[#E8DCC8]'
                  : 'bg-[#3A322A] text-[#D99B52]'
              }`}
              title="将该段落加入复制给智能体的上下文清单"
            >
              +引用此段
            </button>
          </>
        )}
      </div>
    );
  };

  // 决策回执 T1（渲染期）：单个表单项 → 可交互行。真实 checkbox（勾选状态走
  // T2 本机持久化）+ 填空槽（_{3,} 保留切分，奇数位换内联输入框）。文本分段
  // 仍走 buildLinkParts → renderLinkParts 既有链路（链接/加粗/代码渲染不降级）；
  // 本函数只在命中行调用，未命中行永不经过（保守回退由调用点分支保证）。
  const renderDecisionItemRow = (item: DecisionFormItem): React.ReactNode => {
    // 保留分隔符切分：偶数位=文本段，奇数位=原下划线段位置 → 换输入框；
    // 槽键=`行:槽序`（同版本内稳定，与快照 fills 键一致）
    const segments = item.text.split(/(_{3,})/);
    const nodes: React.ReactNode[] = [];
    segments.forEach((seg, idx) => {
      if (idx % 2 === 1) {
        const slotKey = `${item.line}:${Math.floor(idx / 2)}`;
        nodes.push(
          <input
            key={`fill-${slotKey}`}
            type="text"
            value={receiptState?.key === receiptStorageKey ? receiptState.fills[slotKey] ?? '' : ''}
            onChange={(e) => setDecisionFillValue(slotKey, e.target.value)}
            aria-label={`填空：${fillPromptOf(item.text)}`}
            data-decision-fill={slotKey}
            placeholder="填写…"
            className="mx-1 inline-block w-40 rounded-sm border-b bg-transparent px-1 py-0 text-[length:var(--text-ui-body)] leading-[var(--lh-ui-body)] transition-colors border-[color:var(--glass-hairline-strong)] focus:border-[color:var(--stage-ink-decision)] focus:outline-none"
          />
        );
      } else if (seg) {
        // 文本段走既有链接/行内格式渲染（决策行的链接点击导航语义不变）
        nodes.push(
          <React.Fragment key={`seg-${idx}`}>
            {renderLinkParts(buildLinkParts(seg, markdownLinkIndex), activeSectionId)}
          </React.Fragment>
        );
      }
    });
    if (item.checkbox) {
      const checked =
        receiptState?.key === receiptStorageKey
          ? Boolean(receiptState.checks[item.line])
          : Boolean(item.checkbox.initialChecked);
      return (
        // label 包裹：点文字即切换勾选（填空输入框属交互后代，浏览器不会把
        // 点击转发给 checkbox，符合 HTML label 激活行为规范）；单选簇渲染
        // radio（同 name 供箭头键导航），互斥语义由 toggle 的簇清零保证
        <label className="flex items-start gap-2.5 py-0.5 cursor-pointer">
          <input
            type={item.radio ? 'radio' : 'checkbox'}
            name={item.radio ? `decision-radio-${item.radio.zoneId}` : undefined}
            checked={checked}
            onChange={() => toggleDecisionCheck(item.line)}
            data-decision-check={item.line}
            aria-label={`决策项：${item.text}`}
            className={`mt-[0.3em] shrink-0 accent-[color:var(--stage-ink-decision)] ${
              item.radio ? 'rounded-full' : 'rounded'
            }`}
          />
          <span className="min-w-0">{nodes}</span>
        </label>
      );
    }
    return <div className="py-0.5">{nodes}</div>;
  };

  // 行模型 → JSX（逐字对应旧解析循环的各分支 JSX；易变态在此叠加）。
  // deps 说明：本函数体只读 block 数据 + 上述易变态，不持有任何解析状态。
  const renderMarkdownBlock = (block: MarkdownBlock): React.ReactNode => {
    switch (block.kind) {
      case 'code':
        return wrapLine(
          block.line,
          <pre
            className={`p-4 rounded-lg font-mono text-[13px] leading-[1.6] overflow-x-auto border ${
              paperLightMode
                ? 'bg-[#F0EEE6] text-[#1F1E1D] border-[#DDD9CF]'
                : 'bg-[#262524] text-[#C9C5BD] border-[#383633]'
            }`}
          >
            <code>{block.text}</code>
          </pre>,
          block.excerpt
        );

      case 'table':
        return wrapLine(
          block.line,
          <div
            className={`my-3 overflow-x-auto border-y ${
              paperLightMode ? 'border-[#DDD9CF]' : 'border-[#383633]'
            }`}
          >
            <table className="w-full text-left border-collapse text-[length:var(--text-ui-body)] leading-[1.6] tabular-nums">
              <thead>
                <tr
                  className={`bg-transparent font-medium text-[length:var(--text-ui)] border-b ${
                    paperLightMode
                      ? 'border-[#DDD9CF] text-[#6E6A61]'
                      : 'border-[#383633] text-[#A1A09A]'
                  }`}
                >
                  {block.headerCells.map((cell, cIdx) => (
                    <th key={cIdx} className="py-2.5 px-4 whitespace-nowrap">
                      {cell}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody
                className={`divide-y ${
                  paperLightMode ? 'divide-[#EFEDE7]' : 'divide-[#31302D]'
                }`}
              >
                {block.rows.map((row, rIdx) => (
                  <tr
                    key={rIdx}
                    data-event-source-line={row.line}
                    style={row.line === sourceLine ? { outline: '2px solid #9b8afb' } : undefined}
                    className={
                      paperLightMode
                        ? 'hover:bg-[#F5F4EE]'
                        : 'hover:bg-[#2A2825]'
                    }
                  >
                    {row.cells.map((cell, cIdx) => (
                      <td
                        key={cIdx}
                        // R2：单元格最小可读宽——纸面窄时表格不再把字挤成
                        // 逐字竖折，而是撑破 min-content 触发外层
                        // overflow-x-auto 横向滚动（整行横向阅读）
                        className="py-2.5 px-4 align-top min-w-[8em]"
                      >
                        {renderLinkParts(cell, activeSectionId)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>,
          block.excerpt
        );

      case 'h1':
        return wrapLine(
          block.line,
          /* display 档（§3.2）：28/38 serif 700（全应用唯一 700，D1 后为真 700）；
             节距 mt-[34px] mb-[13px]＝17px 正文基准的 2em/0.75em（D8 px 定值） */
          <h1 className="font-serif-claude text-[length:var(--text-display)] leading-[var(--lh-display)] font-bold tracking-tight mt-[34px] mb-[13px]">
            {block.title}
          </h1>
        );

      case 'h2': {
        const isHighlighted = activeSectionId === block.title;
        return wrapLine(
          block.line,
          <div
            className={`flex items-center justify-between pt-8 pb-2 border-b ${
              paperLightMode ? 'border-[#E3E0D8]' : 'border-[#383633]'
            } ${
              isHighlighted
                ? paperLightMode
                  ? 'text-[#9A5B33]'
                  : 'text-[#D99B52]'
                : ''
            }`}
          >
            <h2 className="font-serif-claude text-[length:var(--text-title)] leading-[var(--lh-title)] font-semibold">
              {block.title}
            </h2>
            <button
              type="button"
              onClick={() =>
                onMarkReadHere(
                  activeFile.file_id,
                  currentRev.revision_id,
                  block.title
                )
              }
              className={`text-xs font-normal ${
                paperLightMode
                  ? 'text-[#8A857C] hover:text-[#9A6A45]'
                  : 'text-[#6E6D68] hover:text-[#D99B52]'
              }`}
            >
              {readingState?.last_section_id === block.title
                ? '✓ 已读到这里'
                : '标记已读到这里'}
            </button>
          </div>,
          block.excerpt
        );
      }

      case 'h3':
        return wrapLine(
          block.line,
          <h3 className="font-serif-claude text-[18px] font-semibold mt-5 mb-2">
            {block.title}
          </h3>,
          block.excerpt
        );

      case 'task': {
        // 决策回执 T1：命中表单项的行换可交互渲染（真实 checkbox + 填空槽）；
        // 未命中的任务项保持只读 checkbox（原文档的普通 TODO 不因本票被激活）
        const decisionItem = decisionFormItems.get(block.line);
        if (decisionItem) {
          return wrapLine(block.line, renderDecisionItemRow(decisionItem), block.excerpt);
        }
        return wrapLine(
          block.line,
          <div className="flex items-center gap-2.5 py-0.5">
            <input
              type="checkbox"
              checked={block.checked}
              readOnly
              disabled
              aria-label={`只读任务项：${block.text}`}
              title={`只读任务项：${block.text}（只读 · 不回写源文件）`}
              className={`rounded border-slate-400 ${
                paperLightMode ? 'accent-[#9A6A45]' : 'accent-[#D99B52]'
              }`}
            />
            {/* 任务项不传 sectionHint（旧 :2323 无第二参），回落 activeSectionId 语义不变 */}
            <span>{renderLinkParts(block.parts)}</span>
          </div>,
          block.excerpt
        );
      }

      case 'quote':
        return wrapLine(
          block.line,
          <blockquote
            className={`border-l-[3px] border-[#D97757] pl-4 pr-2 py-1 my-[0.9em] ${
              paperLightMode
                ? 'bg-[#F5F0E8] text-[#4A463F]'
                : 'bg-[#262320] text-[#B8B3A8]'
            }`}
          >
            {renderLinkParts(block.parts, activeSectionId)}
          </blockquote>,
          block.excerpt
        );

      case 'hr':
        return wrapLine(
          block.line,
          <hr
            className={`border-t my-[0.9em] ${
              paperLightMode ? 'border-[#DDD9CF]' : 'border-[#383633]'
            }`}
          />
        );

      case 'ul': {
        // 决策回执 T1：行号命中表单项（如「- 联系人：___」填空行）换可交互渲染；
        // 未命中保持原 bullet 渲染零改动
        const decisionItemUl = decisionFormItems.get(block.line);
        if (decisionItemUl) {
          return wrapLine(block.line, renderDecisionItemRow(decisionItemUl), block.excerpt);
        }
        return wrapLine(
          block.line,
          <div className="flex items-baseline gap-2.5 my-[0.9em]">
            <span
              aria-hidden="true"
              className={`select-none shrink-0 ${
                paperLightMode ? 'text-[#9A6A45]' : 'text-[#D99B52]'
              }`}
            >
              •
            </span>
            <span>
              {renderLinkParts(block.parts, activeSectionId)}
            </span>
          </div>,
          block.excerpt
        );
      }

      case 'ol':
        return wrapLine(
          block.line,
          <div className="flex items-baseline gap-2.5 my-[0.9em]">
            <span
              aria-hidden="true"
              className={`select-none shrink-0 font-mono text-[0.88em] ${
                paperLightMode ? 'text-[#9A6A45]' : 'text-[#D99B52]'
              }`}
            >
              {block.marker}.
            </span>
            <span>
              {renderLinkParts(block.parts, activeSectionId)}
            </span>
          </div>,
          block.excerpt
        );

      case 'p': {
        // 决策回执 T1：□ 选项行/填空行在模型层落为 p 块——行号命中即换可交互渲染；
        // 未命中的段落逐字回退原渲染（含行内提及「□」的普通文章，绝不强改）
        const decisionItemP = decisionFormItems.get(block.line);
        if (decisionItemP) {
          return wrapLine(block.line, renderDecisionItemRow(decisionItemP), block.excerpt);
        }
        return wrapLine(
          block.line,
          <p className="my-[0.9em]">
            {renderLinkParts(block.parts, activeSectionId)}
          </p>,
          block.excerpt
        );
      }
    }
  };
  return {
    renderInlineTokens,
    renderLinkParts,
    wrapLine,
    renderDecisionItemRow,
    renderMarkdownBlock,
  };
}
