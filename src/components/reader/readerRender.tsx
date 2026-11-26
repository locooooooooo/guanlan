
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
  flashSourceLine?: number;
  annotationsByLine: Map<number, ReaderAnnotation[]>;
  onAnnotateBlock: (line: number, excerpt: string) => void;
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



  const renderInlineTokens = (tokens: import('./readerMarkdownModel').InlineToken[], keyPrefix: string): React.ReactNode => {
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
            className="shrink-0 self-center flex items-center gap-0.5 text-[length:var(--text-micro)] font-sans px-1.5 py-0.5 rounded-[var(--r-ctl)] text-[#7A5130] dark:text-[#E5A96A] bg-[#FBF3E4] dark:bg-[#3A322A] opacity-90 hover:opacity-100 transition-opacity"
          >
            批注 {lineAnnotations.length}
          </button>
        )}
        {excerptForCopy && excerptForCopy.length > 8 && (
          <>
            <button
              type="button"
              onClick={() => onAnnotateBlock(lineNum, excerptForCopy)}
              className={`opacity-0 group-hover:opacity-100 focus-visible:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100 [@media(pointer:coarse)]:opacity-100 transition-opacity text-[length:var(--text-micro)] font-sans px-2 py-0.5 rounded-[var(--r-ctl)] shrink-0 ${
                paperLightMode
                  ? 'bg-[#EFE4D5] text-[#6B4728] hover:bg-[#E8DCC8]'
                  : 'bg-[#3A322A] text-[#E5B372]'
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
              className={`opacity-0 group-hover:opacity-100 focus-visible:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100 [@media(pointer:coarse)]:opacity-100 transition-opacity text-[length:var(--text-micro)] font-sans px-2 py-0.5 rounded-[var(--r-ctl)] shrink-0 ${
                paperLightMode
                  ? 'bg-[#EFE4D5] text-[#6B4728] hover:bg-[#E8DCC8]'
                  : 'bg-[#3A322A] text-[#E5B372]'
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

  const renderDecisionItemRow = (item: DecisionFormItem): React.ReactNode => {
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
                  ? 'text-[#5E5A52] hover:text-[#3A342C]'
                  : 'text-[#A8A6A0] hover:text-[#E5B372]'
              }`}
            >
              {readingState?.last_section_id === block.title
                ? '已读到这里'
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
