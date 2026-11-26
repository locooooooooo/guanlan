import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  buildPdfHref,
  formatPdfAnchorLabel,
  parsePdfLinkHref,
  pickPrimaryPdfEvidence,
  resolveMarkdownFileTargetPdf,
} from '../src/utils/pdfAnchor';
import { fetchRevisionPdf, setApiBaseUrl } from '../src/services/workspaceClient';
import type { DecisionAssertion, FileRecord } from '../src/types/guanlan';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = path.resolve(TEST_DIR, '../src');

describe('PDF 页码证据锚点解析纯函数', () => {
  it('parsePdfLinkHref 兼容 page=14 / p=14 / 14 / RFC 3778 拼接并拒绝非法页码', () => {
    const canonical = parsePdfLinkHref('../specs/spec.pdf#page=14');
    assert.equal(canonical.pathWithoutFragment, '../specs/spec.pdf');
    assert.deepEqual(canonical.anchor, { kind: 'pdf_page', page: 14 });
    assert.equal(formatPdfAnchorLabel(canonical.anchor), '第 14 页');

    assert.deepEqual(parsePdfLinkHref('spec.pdf#p=3')?.anchor, { kind: 'pdf_page', page: 3 });
    assert.deepEqual(parsePdfLinkHref('spec.pdf#3')?.anchor, { kind: 'pdf_page', page: 3 });
    assert.deepEqual(parsePdfLinkHref('spec.pdf#PAGE=7')?.anchor, { kind: 'pdf_page', page: 7 });
    assert.deepEqual(parsePdfLinkHref('spec.pdf#page=14&view=FitH')?.anchor, {
      kind: 'pdf_page',
      page: 14,
    });
    assert.deepEqual(parsePdfLinkHref('spec.pdf#p.2')?.anchor, { kind: 'pdf_page', page: 2 });

    assert.equal(parsePdfLinkHref('spec.pdf#page=0').anchor, undefined);
    assert.equal(parsePdfLinkHref('spec.pdf#page=abc').anchor, undefined);
    assert.equal(parsePdfLinkHref('README.md#page=2').anchor, undefined);
    assert.equal(parsePdfLinkHref('spec.pdf').anchor, undefined);
    assert.equal(parsePdfLinkHref('spec.pdf#view=FitH').anchor, undefined);

    assert.equal(
      formatPdfAnchorLabel({ kind: 'pdf_page', page: 2, heading: '第三章 冻结窗口' }),
      '第 2 页 · 第三章 冻结窗口'
    );
    assert.equal(buildPdfHref('specs\\规范.pdf', 2), 'specs/规范.pdf#page=2');
  });

  it('resolveMarkdownFileTargetPdf 跨目录相对引用精确落盘并携带页码锚点', () => {
    const files: FileRecord[] = [
      { file_id: 'f1', relative_path: 'decisions/plan.md' } as FileRecord,
      { file_id: 'f2', relative_path: 'specs/spec.pdf' } as FileRecord,
    ];
    const hit = resolveMarkdownFileTargetPdf('../specs/spec.pdf#page=2', 'decisions/plan.md', files);
    assert.equal(hit?.file.file_id, 'f2');
    assert.deepEqual(hit?.anchor, { kind: 'pdf_page', page: 2 });

    const miss = resolveMarkdownFileTargetPdf('../specs/missing.pdf#page=2', 'decisions/plan.md', files);
    assert.equal(miss, null);
  });

  it('pickPrimaryPdfEvidence 选出携带 pdfAnchor 的直跳证据', () => {
    const dec: Pick<DecisionAssertion, 'evidences'> = {
      evidences: [
        {
          source_id: 'st_1',
          file_id: 'f_md',
          revision_id: 'rev_md',
          relative_path: 'decisions/plan.md',
          lineStart: 1,
          lineEnd: 3,
          observed_at: '2026-11-20T12:00:00Z',
          claimedStatus: '待确认',
          exactQuote: '冻结窗口 30 天',
          note: '',
        },
        {
          source_id: 'st_1_pdf',
          file_id: 'f_pdf',
          revision_id: 'rev_pdf',
          relative_path: 'specs/spec.pdf',
          lineStart: 2,
          lineEnd: 2,
          observed_at: '2026-11-20T12:00:00Z',
          claimedStatus: '待确认',
          exactQuote: '冻结窗口 30 天',
          note: '陈述 st_1 引用 PDF 页码锚点：第 2 页 (specs/spec.pdf)',
          pdfAnchor: { kind: 'pdf_page', page: 2 },
        },
      ],
    };
    const picked = pickPrimaryPdfEvidence(dec);
    assert.equal(picked?.file_id, 'f_pdf');
    assert.equal(picked?.pdfAnchor?.page, 2);
  });
});

describe('fetchRevisionPdf 客户端契约请求', () => {
  let server: http.Server | null = null;

  afterEach(async () => {
    setApiBaseUrl('');
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = null;
    }
  });

  it('正确请求 /api/v1/revisions/{id}/pdf 并解析页级文本载荷（含扫描页诚实标记）', async () => {
    server = http.createServer((req, res) => {
      if (req.url === '/api/v1/revisions/rev_spec_1/pdf') {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        res.end(
          JSON.stringify({
            ok: true,
            index_generation: 4,
            file_id: 'f_spec',
            revision_id: 'rev_spec_1',
            relative_path: 'specs/spec.pdf',
            title: 'spec.pdf',
            format: 'pdf',
            seq: 1,
            content_hash: 'b'.repeat(64),
            size_bytes: 8192,
            snapshot_available: true,
            status: 'page_indexed',
            page_count: 2,
            text_page_count: 1,
            image_only_page_count: 1,
            extract_failed_page_count: 0,
            pages: [
              {
                page_number: 1,
                heading: '第 1 页',
                extracted_text: 'Spec Freeze Window 30d',
                page_kind: 'text',
                image_count: 0,
                char_count: 21,
                visual_summary: '文本页（21 字）',
              },
              {
                page_number: 2,
                heading: '第 2 页 · 纯图像页',
                extracted_text: '',
                page_kind: 'image_only',
                image_count: 1,
                char_count: 0,
                visual_summary: '纯图像页，未做文本抽取（1 张图像，待 OCR）',
              },
            ],
            plain_text: '[第 1 页]\nSpec Freeze Window 30d',
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

    const hit = await fetchRevisionPdf('rev_spec_1');
    assert.equal(hit.ok, true);
    if (hit.ok) {
      assert.equal(hit.data.status, 'page_indexed');
      assert.equal(hit.data.page_count, 2);
      assert.equal(hit.data.pages[0]?.extracted_text, 'Spec Freeze Window 30d');
      assert.equal(hit.data.pages[1]?.page_kind, 'image_only');
      assert.ok(hit.data.pages[1]?.visual_summary.includes('纯图像页'));
    }
  });
});

describe('独立组件架构与端到端页码直达接线检查', () => {
  it('PdfReaderView 独立落地并接入 ReaderView / QuickPreviewModal / 决定卡片直达', () => {
    const pdfViewSrc = fs.readFileSync(
      path.join(SRC_ROOT, 'components/PdfReaderView.tsx'),
      'utf8'
    );
    assert.ok(pdfViewSrc.includes('data-pdf-page='), 'PDF 页级视图带精确页码锚点标记');
    assert.ok(pdfViewSrc.includes('fetchRevisionPdf'), '调用 /pdf 页级文本端点');
    assert.ok(pdfViewSrc.includes('纯图像页，未做文本抽取'), '扫描页诚实标注零假阳性');

    const quickModalSrc = fs.readFileSync(
      path.join(SRC_ROOT, 'components/QuickPreviewModal.tsx'),
      'utf8'
    );
    assert.ok(
      quickModalSrc.includes("effectiveKind === 'pdf'") &&
        quickModalSrc.includes('preview?.pdf_summary'),
      'QuickLook 轻预览支持 PDF 页级摘要'
    );

    const radarSrc = fs.readFileSync(
      path.join(SRC_ROOT, 'components/DecisionRadar.tsx'),
      'utf8'
    );
    assert.ok(radarSrc.includes('pickPrimaryPdfEvidence'), '决定雷达支持直达 PDF 页码证据');

    const inspectorSrc = fs.readFileSync(
      path.join(SRC_ROOT, 'components/RightInspector.tsx'),
      'utf8'
    );
    assert.ok(inspectorSrc.includes('pickPrimaryPdfEvidence'), '检查器关联决定卡支持直达 PDF 页码证据');

    const graphSrc = [
      'components/GraphCanvasView.tsx',
      'components/graph/useGraphCanvasController.tsx',
      'components/graph/graphCanvasNarrative.tsx',
    ]
      .map((p) => fs.readFileSync(path.join(SRC_ROOT, p), 'utf8'))
      .join('\n');
    assert.ok(graphSrc.includes('pickPrimaryPdfEvidence'), '画布叙事抽屉支持直达 PDF 页码证据');

    const readerSrc = [
      'components/ReaderView.tsx',
      'components/reader/useReaderController.tsx',
      'components/reader/readerSvgPdfSections.tsx',
    ]
      .map((p) => fs.readFileSync(path.join(SRC_ROOT, p), 'utf8'))
      .join('\n');
    assert.ok(
      !readerSrc.includes('fetchRevisionPdf'),
      'ReaderView 巨石未直连 PDF 请求细节，保持独立子视图边界'
    );
    assert.ok(
      readerSrc.includes('pdfAnchor') && readerSrc.includes('PdfReaderView'),
      'ReaderView 仅透传 pdfAnchor 并复用独立 PdfReaderView'
    );

    const appSrc = ['App.tsx', 'stores/useWorkspaceStore.tsx', 'components/app/AppLibraryStage.tsx']
      .map((p) => fs.readFileSync(path.join(SRC_ROOT, p), 'utf8'))
      .join(String.fromCharCode(10))
    assert.ok(appSrc.includes('pdfAnchor'), 'App 级 readerAnchor 携带 pdfAnchor 直达链路');
  });
});
