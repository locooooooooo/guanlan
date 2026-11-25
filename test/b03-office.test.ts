import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  buildCellRangeFromCoords,
  colIdxToLetters,
  formatOfficeAnchorLabel,
  isCellInRange,
  normalizeRelativeWorkspacePath,
  parseCellRef,
  parseOfficeLinkHref,
  parseXlsxRangeBounds,
  pickPrimaryOfficeEvidence,
  resolveMarkdownFileTarget,
} from '../src/utils/officeAnchor';
import { isStructuredOfficeFormat } from '../src/utils/formatMeta';
import { fetchRevisionOffice, setApiBaseUrl } from '../src/services/workspaceClient';
import type { DecisionAssertion, FileRecord } from '../src/types/guanlan';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = path.resolve(TEST_DIR, '../src');

describe('Office（.docx / .xlsx）证据锚点与路径解析纯函数', () => {
  it('parseCellRef / parseXlsxRangeBounds / isCellInRange / buildCellRangeFromCoords 精确互逆', () => {
    assert.deepEqual(parseCellRef('A1'), { col: 1, row: 1 });
    assert.deepEqual(parseCellRef('$AB$12'), { col: 28, row: 12 });
    assert.equal(parseCellRef('bad-ref'), null);

    assert.equal(colIdxToLetters(1), 'A');
    assert.equal(colIdxToLetters(28), 'AB');
    assert.equal(buildCellRangeFromCoords({ col: 3, row: 5 }, { col: 2, row: 2 }), 'B2:C5');
    assert.equal(buildCellRangeFromCoords({ col: 2, row: 3 }), 'B3');

    const bounds = parseXlsxRangeBounds('$B$2:$C$5');
    assert.deepEqual(bounds, { startCol: 2, endCol: 3, startRow: 2, endRow: 5 });
    assert.equal(isCellInRange(2, 2, bounds), true);
    assert.equal(isCellInRange(3, 5, bounds), true);
    assert.equal(isCellInRange(4, 3, bounds), false);
    assert.equal(isCellInRange(2, 6, bounds), false);
  });

  it('parseOfficeLinkHref 正确解析 .xlsx#Sheet!Range 与 .docx#para=N', () => {
    const xlsxParsed = parseOfficeLinkHref('../specs/bom.xlsx#BOM!$B$2:$B$3');
    assert.equal(xlsxParsed.pathWithoutFragment, '../specs/bom.xlsx');
    assert.deepEqual(xlsxParsed.anchor, {
      kind: 'xlsx_range',
      sheet: 'BOM',
      cellRange: 'B2:B3',
    });
    assert.equal(formatOfficeAnchorLabel(xlsxParsed.anchor), 'BOM!B2:B3');

    const quotedSheet = parseOfficeLinkHref("quote.xlsx#'Q4 报价'!C4");
    assert.deepEqual(quotedSheet.anchor, {
      kind: 'xlsx_range',
      sheet: 'Q4 报价',
      cellRange: 'C4',
    });

    const docxParsed = parseOfficeLinkHref('specs/plan.docx#para=12');
    assert.equal(docxParsed.pathWithoutFragment, 'specs/plan.docx');
    assert.deepEqual(docxParsed.anchor, {
      kind: 'docx_paragraph',
      paragraph: 12,
    });
    assert.equal(formatOfficeAnchorLabel(docxParsed.anchor), '第 12 段');

    const nonOffice = parseOfficeLinkHref('README.md#section-1');
    assert.equal(nonOffice.pathWithoutFragment, 'README.md');
    assert.equal(nonOffice.anchor, undefined);
  });

  it('normalizeRelativeWorkspacePath 与 resolveMarkdownFileTarget 跨目录相对引用精确落盘', () => {
    assert.equal(
      normalizeRelativeWorkspacePath('decisions/cost.md', '../specs/bom.xlsx'),
      'specs/bom.xlsx'
    );
    assert.equal(
      normalizeRelativeWorkspacePath('a/b/c.md', './sub/plan.docx'),
      'a/b/sub/plan.docx'
    );

    const files = [
      { file_id: 'f1', relative_path: 'decisions/cost.md' },
      { file_id: 'f2', relative_path: 'specs/bom.xlsx' },
      { file_id: 'f3', relative_path: 'specs/plan.docx' },
    ];
    const hitXlsx = resolveMarkdownFileTarget('../specs/bom.xlsx#BOM!B2:B3', 'decisions/cost.md', files);
    assert.equal(hitXlsx?.file.file_id, 'f2');
    assert.deepEqual(hitXlsx?.anchor, {
      kind: 'xlsx_range',
      sheet: 'BOM',
      cellRange: 'B2:B3',
    });

    const hitDocx = resolveMarkdownFileTarget('../specs/plan.docx#para=3', 'decisions/cost.md', files);
    assert.equal(hitDocx?.file.file_id, 'f3');
    assert.deepEqual(hitDocx?.anchor, {
      kind: 'docx_paragraph',
      paragraph: 3,
    });
  });

  it('isStructuredOfficeFormat 与 pickPrimaryOfficeEvidence 正确筛选结构化 Office 与锚定证据', () => {
    assert.equal(isStructuredOfficeFormat('docx'), true);
    assert.equal(isStructuredOfficeFormat('xlsx'), true);
    assert.equal(isStructuredOfficeFormat('.XLSM'), true);
    assert.equal(isStructuredOfficeFormat('csv'), false);
    assert.equal(isStructuredOfficeFormat('pdf'), false);

    const dec: Pick<DecisionAssertion, 'evidences'> = {
      evidences: [
        {
          source_id: 'st_1',
          file_id: 'f_md',
          revision_id: 'rev_md',
          relative_path: 'decisions/cost.md',
          lineStart: 1,
          lineEnd: 3,
          observed_at: '2026-11-19T12:00:00Z',
          claimedStatus: '待确认',
          exactQuote: '核定 BOM',
          note: '',
        },
        {
          source_id: 'st_1_office',
          file_id: 'f_xlsx',
          revision_id: 'rev_xlsx',
          relative_path: 'specs/bom.xlsx',
          lineStart: 2,
          lineEnd: 3,
          observed_at: '2026-11-19T12:00:00Z',
          claimedStatus: '待确认',
          exactQuote: '核定 BOM',
          note: '',
          officeAnchor: {
            kind: 'xlsx_range',
            sheet: 'BOM',
            cellRange: 'B2:B3',
          },
        },
      ],
    };
    const picked = pickPrimaryOfficeEvidence(dec);
    assert.equal(picked?.file_id, 'f_xlsx');
    assert.equal(picked?.officeAnchor?.cellRange, 'B2:B3');
  });
});

describe('fetchRevisionOffice 客户端契约请求', () => {
  let server: http.Server | null = null;

  afterEach(async () => {
    setApiBaseUrl('');
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = null;
    }
  });

  it('正确请求 /api/v1/revisions/{id}/office 并解析 xlsx/docx 结构化载荷', async () => {
    server = http.createServer((req, res) => {
      if (req.url === '/api/v1/revisions/rev_bom_1/office') {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        res.end(
          JSON.stringify({
            ok: true,
            index_generation: 3,
            file_id: 'f_bom',
            revision_id: 'rev_bom_1',
            relative_path: 'specs/bom.xlsx',
            title: 'bom.xlsx',
            format: 'xlsx',
            seq: 1,
            content_hash: 'a'.repeat(64),
            size_bytes: 4096,
            snapshot_available: true,
            status: 'indexed',
            xlsx: {
              sheets: [
                {
                  name: 'BOM',
                  index: 0,
                  headers: ['Item', 'Total'],
                  row_count: 3,
                  col_count: 2,
                  numeric_summaries: [
                    {
                      col_letter: 'B',
                      header: 'Total',
                      count: 2,
                      min: 42.5,
                      max: 85,
                      sum: 127.5,
                      cell_range: 'B2:B3',
                    },
                  ],
                  rows: [],
                  truncated: false,
                },
              ],
              total_sheets: 1,
              truncated: false,
            },
            plain_text: 'Item\tTotal',
          })
        );
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'NOT_FOUND', message: 'missing' }));
    });

    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    assert.ok(addr && typeof addr !== 'string');
    setApiBaseUrl(`http://127.0.0.1:${addr.port}`);

    const hit = await fetchRevisionOffice('rev_bom_1');
    assert.equal(hit.ok, true);
    if (hit.ok) {
      assert.equal(hit.data.status, 'indexed');
      assert.equal(hit.data.xlsx?.sheets[0]?.name, 'BOM');
      assert.equal(hit.data.xlsx?.sheets[0]?.numeric_summaries[0]?.cell_range, 'B2:B3');
    }
  });
});

describe('独立组件架构与端到端证据直达接线检查', () => {
  it('OfficeReaderView 独立落地并通过 NonLegacyFilePreviewPanel / QuickPreviewModal / 决定卡片接线', () => {
    const officeViewSrc = fs.readFileSync(
      path.join(SRC_ROOT, 'components/OfficeReaderView.tsx'),
      'utf8'
    );
    assert.ok(officeViewSrc.includes('data-office-para='), '.docx 段落带精确锚点标记');
    assert.ok(officeViewSrc.includes('data-xlsx-cell='), '.xlsx 单元格带精确坐标标记');
    assert.ok(officeViewSrc.includes('fetchRevisionOffice'), '调用 /office L2 结构化端点');

    const nonLegacySrc = fs.readFileSync(
      path.join(SRC_ROOT, 'components/NonLegacyFilePreviewPanel.tsx'),
      'utf8'
    );
    assert.ok(nonLegacySrc.includes('OfficeReaderView'), 'NonLegacyFilePreviewPanel 复用独立 OfficeReaderView');

    const quickModalSrc = fs.readFileSync(
      path.join(SRC_ROOT, 'components/QuickPreviewModal.tsx'),
      'utf8'
    );
    assert.ok(
      quickModalSrc.includes("effectiveKind === 'office'") &&
        quickModalSrc.includes('preview?.office_summary'),
      'QuickLook 轻预览支持 Office 摘要视图'
    );

    const radarSrc = fs.readFileSync(
      path.join(SRC_ROOT, 'components/DecisionRadar.tsx'),
      'utf8'
    );
    assert.ok(radarSrc.includes('pickPrimaryOfficeEvidence'), '决定雷达支持直达 Office 证据');

    const inspectorSrc = fs.readFileSync(
      path.join(SRC_ROOT, 'components/RightInspector.tsx'),
      'utf8'
    );
    assert.ok(inspectorSrc.includes('pickPrimaryOfficeEvidence'), '检查器关联决定卡支持直达 Office 证据');

    const readerSrc = fs.readFileSync(
      path.join(SRC_ROOT, 'components/ReaderView.tsx'),
      'utf8'
    );
    assert.ok(
      !readerSrc.includes('fetchRevisionOffice'),
      'ReaderView 巨石未直连 Office 请求细节，保持独立子视图边界'
    );
    assert.ok(readerSrc.includes('officeAnchor'), 'ReaderView 仅透传 officeAnchor');
  });
});
