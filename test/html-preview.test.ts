import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { FileRecord, Revision } from '../src/types/guanlan';
import { formatClassOf, isPreviewableHtmlFormat } from '../src/utils/formatMeta';
import {
  buildHtmlSandboxDocument,
  collectLocalInlineAssetTargets,
  inspectHtmlFeatures,
  resolveRelativeAssetPath,
} from '../src/utils/htmlPreview';
import {
  NonLegacyFilePreviewPanel,
  resolveNonLegacyPreviewMode,
} from '../src/components/NonLegacyFilePreviewPanel';
import { getApiBaseUrl, setApiBaseUrl } from '../src/services/workspaceClient';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SRC_ROOT = path.resolve(__dirname, '../src');

function makeFile(
  fileId: string,
  relativePath: string,
  format: string,
  opts: { revId?: string; sizeBytes?: number; snapshotAvailable?: boolean; content?: string } = {}
): FileRecord {
  const revId = opts.revId ?? `rev_${fileId}`;
  const rev: Revision = {
    revision_id: revId,
    file_id: fileId,
    versionNumber: 1,
    content_sha256: 'a'.repeat(64),
    observed_at: '2026-11-23T12:00:00Z',
    source_time: '2026-11-23T12:00:00Z',
    sizeBytes: opts.sizeBytes ?? 1024,
    snapshotAvailable: opts.snapshotAvailable ?? true,
    isBaselineProtected: true,
    markdownContent: opts.content,
    summaryNote: 'v1',
  };
  return {
    file_id: fileId,
    relative_path: relativePath,
    title: path.posix.basename(relativePath),
    format,
    folder: path.posix.dirname(relativePath),
    role: '方案',
    roleProvenance: '来自路径',
    topics: [],
    current_revision_id: revId,
    revisions: [rev],
    coverage: 'full_text',
  };
}

describe('HTML 绘制预览 · 格式分型与相对路径解析', () => {
  it('识别 html/htm/xhtml/shtml 并分流到 NonLegacy html 预览模式', () => {
    for (const ext of ['html', 'HTM', '.xhtml', 'shtml']) {
      assert.equal(isPreviewableHtmlFormat(ext), true, ext);
      assert.equal(formatClassOf(ext), 'code', ext);
      assert.equal(resolveNonLegacyPreviewMode(ext, true), 'html', ext);
      assert.equal(resolveNonLegacyPreviewMode(ext, false), 'metadata_only', ext);
    }
    assert.equal(isPreviewableHtmlFormat('xml'), false);
    assert.equal(isPreviewableHtmlFormat('md'), false);
    assert.equal(isPreviewableHtmlFormat('svg'), false);
  });

  it('resolveRelativeAssetPath 正确归一相对路径并拒绝外部协议与越界逃逸', () => {
    assert.equal(
      resolveRelativeAssetPath('docs/demo/index.html', './chart.png'),
      'docs/demo/chart.png'
    );
    assert.equal(
      resolveRelativeAssetPath('docs/demo/index.html', '../assets/bg.webp?v=2#hero'),
      'docs/assets/bg.webp'
    );
    assert.equal(
      resolveRelativeAssetPath('docs/demo/index.html', 'sub/%E5%9B%BE.png'),
      'docs/demo/sub/图.png'
    );
    assert.equal(resolveRelativeAssetPath('docs/demo/index.html', 'https://cdn.example.com/a.js'), null);
    assert.equal(resolveRelativeAssetPath('docs/demo/index.html', '//cdn.example.com/a.js'), null);
    assert.equal(resolveRelativeAssetPath('docs/demo/index.html', 'data:image/png;base64,AA'), null);
    assert.equal(resolveRelativeAssetPath('docs/demo/index.html', '/root.css'), null);
    assert.equal(resolveRelativeAssetPath('docs/demo/index.html', '../../../etc/passwd'), null);
  });
});

describe('HTML 绘制预览 · 特性识别与沙盒安全红线', () => {
  it('准确识别脚本、Canvas/WebGL、importmap/ESM 与外链，不误伤普通超链接与脚本字符串', () => {
    const html = `<!doctype html>
<html>
<head>
  <link rel="canonical" href="https://docs.example.com/page">
  <link rel="stylesheet" href="https://cdn.example.com/app.css">
  <style>body { background-image: url("https://cdn.example.com/bg.png"); }</style>
  <script type="importmap">{"imports":{"three":"https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.module.js"}}</script>
</head>
<body>
  <a href="https://example.com/readme">外链文档</a>
  <canvas id="scene"></canvas>
  <script type="module">
    import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.module.js';
    const fake = '<img src="https://not-a-real-tag.example/x.png"><head>';
    const ctx = document.getElementById('scene').getContext('webgl2');
    console.log(THREE, fake, ctx);
  </script>
</body>
</html>`;
    const feat = inspectHtmlFeatures(html);
    assert.equal(feat.hasScript, true);
    assert.equal(feat.hasCanvasOrWebgl, true);
    assert.ok(feat.externalUrls.includes('https://cdn.example.com/app.css'));
    assert.ok(feat.externalUrls.includes('https://cdn.example.com/bg.png'));
    assert.ok(
      feat.externalUrls.includes('https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.module.js')
    );
    assert.equal(feat.externalUrls.includes('https://example.com/readme'), false);
    assert.equal(feat.externalUrls.includes('https://docs.example.com/page'), false);
    assert.equal(feat.externalUrls.includes('https://not-a-real-tag.example/x.png'), false);
  });

  it('默认离线沙盒禁止 allow-same-origin 与外网连接，放行 HTTPS 时仍封锁 http://127.0.0.1', () => {
    const raw = `<!doctype html><html><head><base href="https://evil.example/"><title>Demo</title></head><body><canvas id="c"></canvas><script>1+1</script></body></html>`;

    const offline = buildHtmlSandboxDocument(raw, {
      allowScripts: true,
      allowExternalHttps: false,
    });
    assert.equal(offline.sandboxAttr, 'allow-scripts');
    assert.equal(offline.sandboxAttr.includes('allow-same-origin'), false);
    assert.equal(offline.sandboxAttr.includes('allow-top-navigation'), false);
    assert.equal(offline.srcDoc.includes('<base'), false, '必须移除 <base> 标签');
    assert.ok(offline.cspContent.includes("default-src 'none'"));
    assert.ok(offline.cspContent.includes("connect-src data: blob:"));
    assert.ok(offline.cspContent.includes("form-action 'none'"));
    assert.ok(offline.cspContent.includes("base-uri 'none'"));
    assert.equal(offline.cspContent.includes('https:'), false);

    const staticOnly = buildHtmlSandboxDocument(raw, {
      allowScripts: false,
      allowExternalHttps: false,
    });
    assert.equal(staticOnly.sandboxAttr, '');
    assert.ok(staticOnly.cspContent.includes("script-src 'none'"));

    const httpsAllowed = buildHtmlSandboxDocument(raw, {
      allowScripts: true,
      allowExternalHttps: true,
    });
    assert.equal(httpsAllowed.sandboxAttr, 'allow-scripts');
    assert.ok(httpsAllowed.cspContent.includes("script-src 'unsafe-inline' 'unsafe-eval' data: blob: https:"));
    assert.equal(httpsAllowed.cspContent.includes('http:'), false, '放行 HTTPS 时绝不放开明文 http:');
  });

  it('HTML 片段（无 html/head）自动补齐 HTML5 壳并注入 CSP，不破坏脚本内 <head> 字符串', () => {
    const fragment = `<div class="card">Hello</div><script>const s = '<head>fake</head>';</script>`;
    const prepared = buildHtmlSandboxDocument(fragment, {
      allowScripts: true,
      allowExternalHttps: false,
    });
    assert.ok(prepared.srcDoc.startsWith('<!doctype html>'));
    assert.ok(prepared.srcDoc.includes('<meta http-equiv="Content-Security-Policy"'));
    assert.ok(prepared.srcDoc.includes("const s = '<head>fake</head>';"));
  });

  it('当前最新版本自动关联同工作区相对图片与内联本地 CSS/经典 JS，且不破坏闭合标签', () => {
    const htmlFile = makeFile('f_html', 'demo/index.html', 'html');
    const pngFile = makeFile('f_png', 'demo/assets/shot.png', 'png', { revId: 'rev_shot' });
    const cssFile = makeFile('f_css', 'demo/styles.css', 'css', { revId: 'rev_css' });
    const jsFile = makeFile('f_js', 'demo/draw.js', 'js', { revId: 'rev_js' });
    const files = [htmlFile, pngFile, cssFile, jsFile];

    const raw = `<!doctype html>
<html><head>
  <link rel="stylesheet" href="./styles.css">
</head><body>
  <img src="./assets/shot.png" alt="demo">
  <script src="./draw.js"></script>
  <script type="module" src="./esm.js"></script>
</body></html>`;

    const targets = collectLocalInlineAssetTargets(raw, htmlFile.relative_path, files);
    assert.equal(targets.length, 2);
    assert.deepEqual(
      targets.map((t) => t.normalizedPath).sort(),
      ['demo/draw.js', 'demo/styles.css']
    );

    const prepared = buildHtmlSandboxDocument(raw, {
      allowScripts: true,
      allowExternalHttps: false,
      relativePath: htmlFile.relative_path,
      workspaceFiles: files,
      resolveRevisionRawUrl: (id) => `/api/v1/revisions/${id}/content?raw=1`,
      fallbackOrigin: 'http://127.0.0.1:43123',
      inlinedAssets: {
        'demo/styles.css': 'body { color: #222; } /* </style> */',
        'demo/draw.js': 'const tag = "</script>"; console.log(tag);',
      },
    });

    assert.equal(prepared.resolvedLocalAssetCount, 3);
    assert.ok(
      prepared.srcDoc.includes(
        'src="http://127.0.0.1:43123/api/v1/revisions/rev_shot/content?raw=1"'
      )
    );
    assert.ok(
      prepared.cspContent.includes('img-src data: blob: http://127.0.0.1:43123/api/v1/revisions/'),
      '本地快照图片仅向 img-src 开放只读 revisions 前缀'
    );
    assert.equal(
      prepared.cspContent.includes('connect-src data: blob: http://'),
      false,
      'connect-src 绝不能开放本地后端'
    );
    assert.ok(prepared.srcDoc.includes('<style data-guanlan-inlined="demo/styles.css">'));
    assert.ok(prepared.srcDoc.includes('<\\/style>'));
    assert.ok(prepared.srcDoc.includes('<script data-guanlan-inlined="demo/draw.js">'));
    assert.ok(prepared.srcDoc.includes('<\\/script>'));
    assert.deepEqual(prepared.unresolvedLocalAssets, ['./esm.js']);
  });
});

describe('HTML 绘制预览 · 前端组件接线与 SSR 渲染断言', () => {
  it('NonLegacyFilePreviewPanel 对 HTML 文件挂载独立 HtmlReaderView 并输出隔离沙盒 iframe', () => {
    const prevBase = getApiBaseUrl();
    try {
      setApiBaseUrl('http://127.0.0.1:43123');
      const htmlContent = `<!doctype html><html><head><script src="https://cdn.example.com/lib.js"></script></head><body><canvas id="c"></canvas></body></html>`;
      const htmlFile = makeFile('f_html_ssr', '原型/2D3D画布.html', 'html', {
        revId: 'rev_html_ssr',
        content: htmlContent,
      });
      const html = renderToStaticMarkup(
        React.createElement(NonLegacyFilePreviewPanel, {
          activeFile: htmlFile,
          currentRev: htmlFile.revisions[0],
          paperLightMode: true,
          indexGeneration: 1,
          workspaceFiles: [htmlFile],
        })
      );
      assert.ok(html.includes('data-html-reader'), '应挂载 HtmlReaderView');
      const iframeMatch = /<iframe\b[^>]*>/i.exec(html);
      assert.ok(iframeMatch, '默认应直接渲染沙盒 iframe');
      assert.ok(iframeMatch[0].includes('sandbox="allow-scripts"'), '沙盒应开启隔离脚本执行');
      assert.equal(iframeMatch[0].includes('allow-same-origin'), false, 'iframe 绝不可授予 allow-same-origin');
      assert.ok(html.includes('已拦截 1 处外链'), '检测到外部 CDN 时应提示可手动放行');
      assert.ok(html.includes('页面渲染') && html.includes('HTML 源码'), '应提供渲染/源码双视图切换');
    } finally {
      setApiBaseUrl(prevBase);
    }
  });

  it('QuickPreviewModal 与 FileTimelineDrawer 均已接入 HTML 隔离沙盒绘制', () => {
    const nonLegacySrc = fs.readFileSync(
      path.join(SRC_ROOT, 'components/NonLegacyFilePreviewPanel.tsx'),
      'utf8'
    );
    const quickSrc = fs.readFileSync(
      path.join(SRC_ROOT, 'components/QuickPreviewModal.tsx'),
      'utf8'
    );
    const drawerSrc = fs.readFileSync(
      path.join(SRC_ROOT, 'components/FileTimelineDrawer.tsx'),
      'utf8'
    );

    assert.ok(nonLegacySrc.includes('HtmlReaderView'));
    assert.ok(quickSrc.includes('buildHtmlSandboxDocument'));
    assert.ok(quickSrc.includes('data-quick-preview-html'));
    assert.ok(drawerSrc.includes('buildHtmlSandboxDocument'));
  });
});
