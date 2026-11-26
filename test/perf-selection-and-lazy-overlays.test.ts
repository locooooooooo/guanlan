import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

const ROOT = path.resolve(
  path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')),
  '..'
);

function readSrc(rel: string): string {
  return fs.readFileSync(path.join(ROOT, 'src', rel), 'utf8');
}

test('ensureFileDetail 目录元数据未变时仅局部水合 hydratedFilesById，不触发全表 publishFiles 重排', () => {
  const storeSrc = readSrc('stores/useWorkspaceStore.tsx');
  const start = storeSrc.indexOf('const ensureFileDetail = useCallback(');
  const end = storeSrc.indexOf('const ensureRevisionContent = useCallback(', start);
  assert.ok(start >= 0 && end > start);
  const body = storeSrc.slice(start, end);

  assert.ok(body.includes('setHydratedFilesById('), '详情补全须写入局部 hydratedFilesById');
  assert.ok(
    body.includes('if (!catalogUnchanged) {\n        publishFiles();\n      }'),
    '仅当目录结构/版本变化或新文件首次入表时才触发全表 publishFiles'
  );

  const applyStart = storeSrc.indexOf('const applyFileSummaries = useCallback(');
  const applyEnd = storeSrc.indexOf('const mergeEventsPage = useCallback(', applyStart);
  const applyBody = storeSrc.slice(applyStart, applyEnd);
  assert.ok(
    applyBody.includes('invalidatedHydratedIds') && applyBody.includes('setHydratedFilesById'),
    'applyFileSummaries 发现新版本或删除文件时须同步失效 hydratedFilesById 缓存'
  );

  assert.ok(
    storeSrc.includes('const fileById = useMemo(() => new Map(files.map((f) => [f.file_id, f])), [files]);'),
    'activeFile 须走 O(1) fileById 映射而非每次线性 files.find'
  );
  assert.ok(
    storeSrc.includes('return base ? hydratedFilesById[base.file_id] ?? base : base;'),
    'activeFile 须优先返回已水合的详情记录'
  );
  assert.ok(
    storeSrc.includes('if (!sidebarFilterActive) return files;'),
    '无筛选时 filteredFiles 直接复用 files 引用'
  );
});

test('关闭态浮层与阅读器链接索引按需惰性计算，切换文件或目录不再全量空转', () => {
  const storeSrc = readSrc('stores/useWorkspaceStore.tsx');
  assert.ok(
    storeSrc.includes('spotlightEnabled\n        ? computeSpotlightChanges('),
    '增量聚光灯未开启时不扫描全量文件'
  );
  assert.ok(
    storeSrc.includes('const folderOptionsNeeded = Boolean(fileOpModal || dirShell.dirOpModal);'),
    '目录选项仅在文件/目录操作弹层开启时构建'
  );

  const paletteSrc = readSrc('hooks/useCommandPalette.ts');
  assert.ok(
    paletteSrc.includes('isOpen\n        ? assemblePaletteResults('),
    '命令面板关闭时不聚合全量条目'
  );

  const quickSrc = readSrc('hooks/useQuickPreview.ts');
  assert.ok(
    quickSrc.includes('target\n        ? buildQuickPreviewQueue('),
    '轻预览关闭时不构造 4 万文件队列'
  );

  const fileOpsSrc = readSrc('hooks/useFileOps.ts');
  assert.ok(
    fileOpsSrc.includes('modalRequest ? collectWorkspaceFolderOptions(files) : []'),
    'useFileOps 仅在弹窗打开时枚举目录清单'
  );

  const sidebarSrc = readSrc('components/LeftSidebar.tsx');
  assert.ok(
    sidebarSrc.includes('open ? Array.from(new Set(files.map((f) => f.role))) : []'),
    'FilterDropdown 关闭时不扫描角色与主题'
  );

  const readerSrc = readSrc('components/reader/useReaderController.tsx');
  assert.ok(
    readerSrc.includes('const isMarkdownFile = activeFile.format === \'md\';'),
    'ReaderView 非 Markdown 文件不构建全库路径索引'
  );
  assert.ok(
    readerSrc.includes('}, [files, isMarkdownFile]);'),
    'Markdown 路径索引仅随 [files, isMarkdownFile] 重建，切文档不重扫全库'
  );
});
