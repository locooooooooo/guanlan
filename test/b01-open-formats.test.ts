import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { FileRecord, Revision } from '../src/types/guanlan';
import {
  formatClassLabel,
  formatClassOf,
  formatLabel,
  formatUiMeta,
  getCalendarFormatColor,
  isPreviewableImageFormat,
  isUtf8TextFormat,
  normalizeFormatToken,
  snapshotTierDescription,
} from '../src/utils/formatMeta';
import {
  DEFAULT_EXCLUDED_DIRS,
  formatFromFileName,
  validateRenameInput,
} from '../src/utils/fileOps';
import {
  formatByteSize,
  NonLegacyFilePreviewPanel,
  resolveNonLegacyPreviewMode,
} from '../src/components/NonLegacyFilePreviewPanel';
import {
  fetchStorageStats,
  getApiBaseUrl,
  setApiBaseUrl,
  updateStoragePolicy,
} from '../src/services/workspaceClient';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SRC_ROOT = path.resolve(__dirname, '../src');

describe('B01 · formatMeta 统一格式分类与优雅降级', () => {
  it('能正确归一化扩展名并映射至 13 个语义大类', () => {
    assert.equal(normalizeFormatToken('.TSX '), 'tsx');
    assert.equal(normalizeFormatToken(''), 'bin');

    assert.equal(formatClassOf('md'), 'markdown');
    assert.equal(formatClassOf('txt'), 'text');
    assert.equal(formatClassOf('rs'), 'code');
    assert.equal(formatClassOf('gitignore'), 'code');
    assert.equal(formatClassOf('svg'), 'vector');
    assert.equal(formatClassOf('png'), 'image');
    assert.equal(formatClassOf('pdf'), 'document');
    assert.equal(formatClassOf('docx'), 'document');
    assert.equal(formatClassOf('xlsx'), 'spreadsheet');
    assert.equal(formatClassOf('pptx'), 'presentation');
    assert.equal(formatClassOf('zip'), 'archive');
    assert.equal(formatClassOf('mp3'), 'audio');
    assert.equal(formatClassOf('mp4'), 'video');
    assert.equal(formatClassOf('woff2'), 'font');
    assert.equal(formatClassOf('totally_unknown_ext'), 'binary');

    assert.equal(formatLabel('rs'), 'RS');
    assert.equal(formatClassLabel('code'), '源码与配置');
  });

  it('任何未知或新增格式都会返回有效 UI 与日历色值（永不 undefined）', () => {
    for (const fmt of ['md', 'svg', 'pdf', 'ts', 'png', 'docx', 'mp4', 'weirdfmt']) {
      const ui = formatUiMeta(fmt);
      assert.ok(ui.label.length > 0);
      assert.ok(ui.dotColor.length > 0);
      assert.ok(ui.badgeClass.length > 0);
      const cal = getCalendarFormatColor(fmt);
      assert.ok(cal.text.length > 0);
      assert.ok(cal.border.length > 0);
      assert.ok(cal.bg.length > 0);
    }
    const undated = getCalendarFormatColor('undated');
    assert.ok(undated.border.length > 0);
  });

  it('UTF-8 文本判定、可渲染图片判定与三档快照说明准确', () => {
    assert.equal(isUtf8TextFormat('ts'), true);
    assert.equal(isUtf8TextFormat('csv'), true);
    assert.equal(isUtf8TextFormat('xlsx'), false);
    assert.equal(isUtf8TextFormat('png'), false);

    assert.equal(isPreviewableImageFormat('PNG'), true);
    assert.equal(isPreviewableImageFormat('webp'), true);
    assert.equal(isPreviewableImageFormat('psd'), false);

    assert.equal(snapshotTierDescription('ts').tier, 'text');
    assert.equal(snapshotTierDescription('docx').tier, 'binary');
    assert.equal(snapshotTierDescription('mp4').tier, 'metadata_only');
    assert.equal(snapshotTierDescription('bin').tier, 'metadata_only');
  });
});

describe('B01 · fileOps 全格式识别、默认排除与重命名同簇校核', () => {
  it('formatFromFileName 支持常见扩展名、无扩展名已知文件及 dotfiles', () => {
    assert.equal(formatFromFileName('notes.txt'), 'txt');
    assert.equal(formatFromFileName('Makefile'), 'make');
    assert.equal(formatFromFileName('README'), 'readme');
    assert.equal(formatFromFileName('.gitignore'), 'gitignore');
    assert.equal(formatFromFileName('photo.PNG'), 'png');
    assert.equal(formatFromFileName('report.docx'), 'docx');
    assert.equal(formatFromFileName('unknown_blob'), 'bin');
  });

  it('validateRenameInput 同大类兼容、跨大类拒绝，且 sync 默认排除列表', () => {
    assert.equal(validateRenameInput('hero.webp', 'assets/hero.png', 'png').ok, true);
    assert.equal(validateRenameInput('helper.tsx', 'src/helper.ts', 'ts').ok, true);
    assert.equal(validateRenameInput('helper.exe', 'src/helper.ts', 'ts').ok, false);
    assert.equal(validateRenameInput('draft.png', 'docs/draft.docx', 'docx').ok, false);

    assert.ok(DEFAULT_EXCLUDED_DIRS.has('node_modules'));
    assert.ok(DEFAULT_EXCLUDED_DIRS.has('.git'));
    assert.ok(DEFAULT_EXCLUDED_DIRS.has('target'));
  });
});

describe('B01 · L0/L1 非传统文件预览分型', () => {
  it('按快照可用性与格式大类分流 image / text / metadata_only', () => {
    assert.equal(resolveNonLegacyPreviewMode('png', true), 'image');
    assert.equal(resolveNonLegacyPreviewMode('png', false), 'metadata_only');
    assert.equal(resolveNonLegacyPreviewMode('rs', true), 'text');
    assert.equal(resolveNonLegacyPreviewMode('rs', false), 'metadata_only');
    assert.equal(resolveNonLegacyPreviewMode('docx', true), 'office');
    assert.equal(resolveNonLegacyPreviewMode('xlsx', true), 'office');
    assert.equal(resolveNonLegacyPreviewMode('docx', false), 'metadata_only');
    assert.equal(resolveNonLegacyPreviewMode('pptx', true), 'metadata_only');
    assert.equal(resolveNonLegacyPreviewMode('mp4', false), 'metadata_only');

    assert.equal(formatByteSize(0), '0 B');
    assert.equal(formatByteSize(512), '512 B');
    assert.equal(formatByteSize(2048), '2.0 KiB');
    assert.equal(formatByteSize(5 * 1024 * 1024), '5.00 MiB');
  });
});

describe('B01 · /api/v1/storage/stats 与 /api/v1/storage/policy 客户端联调', () => {
  let prevBase = '';
  let server: http.Server | null = null;
  let lastPostBody = '';

  beforeEach(async () => {
    prevBase = getApiBaseUrl();
    lastPostBody = '';
    server = http.createServer(async (req, res) => {
      if (req.method === 'GET' && req.url === '/api/v1/storage/stats') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            ok: true,
            index_generation: 4,
            workspace_id: 'ws_b01_test',
            data_dir_path: 'C:/Users/test/.guanlan/ws_b01_test',
            blobs_bytes: 204800,
            blobs_disk_bytes: 204800,
            blobs_count: 12,
            db_bytes: 163840,
            total_disk_bytes: 368640,
            used_total_mib: 0.35,
            active_files_count: 15,
            revisions_total: 18,
            full_snapshot_revisions: 15,
            metadata_only_revisions: 3,
            gitignore_respected: true,
            policy: {
              text_max_bytes: 10 * 1024 * 1024,
              binary_max_bytes: 50 * 1024 * 1024,
              text_max_mib: 10,
              binary_max_mib: 50,
              metadata_only_classes: ['audio', 'video', 'font', 'binary'],
            },
            by_class: [
              {
                format_class: 'markdown',
                label: 'Markdown 文档',
                files_count: 5,
                revisions_count: 6,
                metadata_only_revisions: 0,
                snapshot_bytes: 40960,
              },
              {
                format_class: 'video',
                label: '视频',
                files_count: 3,
                revisions_count: 3,
                metadata_only_revisions: 3,
                snapshot_bytes: 0,
              },
            ],
            by_format: { md: 5, mp4: 3, ts: 7 },
          })
        );
        return;
      }
      if (req.method === 'POST' && req.url === '/api/v1/storage/policy') {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        lastPostBody = Buffer.concat(chunks).toString('utf8');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            ok: true,
            workspace_id: 'ws_b01_test',
            policy: {
              text_max_bytes: 16 * 1024 * 1024,
              binary_max_bytes: 64 * 1024 * 1024,
              text_max_mib: 16,
              binary_max_mib: 64,
              metadata_only_classes: ['audio', 'video', 'font', 'binary'],
            },
          })
        );
        return;
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('expected port');
    setApiBaseUrl(`http://127.0.0.1:${addr.port}`);
  });

  afterEach(async () => {
    setApiBaseUrl(prevBase);
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = null;
    }
  });

  it('fetchStorageStats 与 updateStoragePolicy 正确解码与提交载荷', async () => {
    const statsRes = await fetchStorageStats();
    assert.equal(statsRes.ok, true);
    if (!statsRes.ok) throw new Error('expected ok');
    assert.equal(statsRes.data.metadata_only_revisions, 3);
    assert.equal(statsRes.data.by_format.mp4, 3);
    assert.equal(statsRes.data.gitignore_respected, true);
    assert.equal(statsRes.data.policy.text_max_mib, 10);

    const updateRes = await updateStoragePolicy(16, 64);
    assert.equal(updateRes.ok, true);
    if (!updateRes.ok) throw new Error('expected ok');
    assert.deepEqual(JSON.parse(lastPostBody), { text_max_mib: 16, binary_max_mib: 64 });
    assert.equal(updateRes.data.policy.binary_max_bytes, 64 * 1024 * 1024);
    assert.equal(updateRes.data.policy.binary_max_mib, 64);
  });
});

describe('B01 · 前端视图接线防退化断言', () => {
  it('设置弹层、阅读器与侧栏已接入 B01 全格式与存储统计组件', () => {
    // V08 拆解 ModalsAndDrawers 后，WorkspaceSettingsModal 实现位于 components/modals/WorkspaceSettingsModal.tsx
    const modals = [
      'components/ModalsAndDrawers.tsx',
      'components/modals/WorkspaceSettingsModal.tsx',
    ]
      .map((rel) => fs.readFileSync(path.join(SRC_ROOT, rel), 'utf8'))
      .join('\n');
    const reader = fs.readFileSync(path.join(SRC_ROOT, 'components/ReaderView.tsx'), 'utf8');
    const sidebar = fs.readFileSync(path.join(SRC_ROOT, 'components/LeftSidebar.tsx'), 'utf8');

    assert.match(modals, /<StorageUsageSection\s+config=\{config\}\s+isOpen=\{isOpen\}\s*\/>/);
    assert.doesNotMatch(modals, /已禁用默认\s*\.gitignore/);
    assert.match(reader, /<NonLegacyFilePreviewPanel/);
    assert.match(sidebar, /formatUiMeta\(/);
    assert.doesNotMatch(sidebar, /Record<FileFormat,/);
  });

  it('Tauri 跨源桌面壳设置 apiBase 后，PNG 预览面板的 img src 与原图链接自动绑定绝对端点', () => {
    const prevBase = getApiBaseUrl();
    try {
      setApiBaseUrl('http://127.0.0.1:43123');
      const rev: Revision = {
        revision_id: 'rev_png_01',
        file_id: 'f_png_01',
        versionNumber: 1,
        content_sha256: 'b11cb93d02cd6e52000000000000000000000000000000000000000000000000',
        observed_at: '2026-11-23T12:00:00Z',
        source_time: '2026-11-23T12:00:00Z',
        sizeBytes: 162201,
        snapshotAvailable: true,
        isBaselineProtected: true,
        summaryNote: 'v1',
      };
      const file: FileRecord = {
        file_id: 'f_png_01',
        relative_path: '验收截图/01-卡片缩略图.png',
        title: '01-卡片缩略图.png',
        format: 'png',
        folder: '验收截图',
        role: '素材',
        roleProvenance: '来自路径',
        topics: [],
        current_revision_id: rev.revision_id,
        revisions: [rev],
        coverage: 'filename_only',
      };
      const html = renderToStaticMarkup(
        React.createElement(NonLegacyFilePreviewPanel, {
          activeFile: file,
          currentRev: rev,
          paperLightMode: true,
          indexGeneration: 1,
        })
      );
      const expected = 'http://127.0.0.1:43123/api/v1/revisions/rev_png_01/content?raw=1';
      assert.ok(html.includes(`src="${expected}"`), 'PNG <img> 必须指向绑定 apiBase 后的绝对 raw 地址');
      assert.ok(html.includes(`href="${expected}"`), '「新窗口查看原图」链接必须指向绑定 apiBase 后的绝对 raw 地址');
    } finally {
      setApiBaseUrl(prevBase);
    }
  });
});
