import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { LeftSidebar } from '../src/components/LeftSidebar';
import type { FileRecord } from '../src/types/guanlan';

const ROOT = path.resolve(
  path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')),
  '..'
);

function readSrc(rel: string): string {
  return fs.readFileSync(path.join(ROOT, 'src', rel), 'utf8');
}

test('LeftSidebar 展开目录或切文件不再跑未缓存全量扫描、O(M²) 格式探测或二次重渲', () => {
  const sidebarSrc = readSrc('components/LeftSidebar.tsx');

  assert.ok(
    sidebarSrc.includes('const continueReadingFiles = useMemo('),
    'continueReadingFiles 须走 useMemo，禁止每次展开目录扫全量 files'
  );
  assert.ok(
    sidebarSrc.includes('const { businessUnreadCount, systemUnreadCount } = useMemo('),
    'businessUnreadCount 须走 useMemo'
  );
  assert.ok(
    sidebarSrc.includes('const bookmarkedCount = useMemo('),
    'bookmarkedCount 须走 useMemo'
  );
  assert.ok(
    sidebarSrc.includes('const SidebarFileLeaf = React.memo(SidebarFileLeafImpl);'),
    'SidebarFileLeaf 须包裹 React.memo'
  );
  assert.ok(
    !sidebarSrc.includes('node.directFiles.some((sibling) => sibling.format !== file.format)'),
    'FolderTreeRows 不得在 renderItem 内执行 O(M²) 的 directFiles.some'
  );
  assert.ok(
    !sidebarSrc.includes('getKey={(file) => file.file_id}'),
    'LeftSidebar 的 VirtualFileSlice 须传提升后的稳定 getSidebarFileKey'
  );
  assert.ok(
    sidebarSrc.includes('if (allPresent) return prev;'),
    'expandAncestors 在祖先已全展开时须直接返回 prev，禁止选中文件触发二次重渲'
  );
  assert.ok(
    sidebarSrc.includes("if (filters.quickScope === 'all') {\n      return folderActivity.get(normalized)?.unreadCount ?? 0;\n    }"),
    'selectedFolderUnreadCount 在全部视角须直接 O(1) 读取 folderActivity'
  );

  const branchSrc = readSrc('components/sidebar/ProjectTreeBranch.tsx');
  assert.ok(
    !branchSrc.includes('getKey={(file) => file.file_id}'),
    'ProjectTreeBranch 的 VirtualFileSlice 须传提升后的稳定 getProjectTreeFileKey'
  );
  assert.ok(branchSrc.includes('getCachedProjectSiblingPrefixMap('));

  const stageSrc = readSrc('components/app/AppLibraryStage.tsx');
  assert.ok(
    stageSrc.includes("if (libraryMode !== 'overview' || sidebarFilters.folder === 'all')"),
    'AppLibraryStage 在阅读态不得计算仅概览面包屑展示的 activeFolderReadStats'
  );
  assert.ok(
    stageSrc.includes('packages={ctx.packageList}'),
    'AppLibraryStage 须把已缓存的 packageList 传给 RightInspector，禁止重复 groupFilesIntoPackages'
  );
  assert.ok(
    stageSrc.includes("(libraryMode === 'overview' && !overviewInspectorCollapsed)) && ("),
    'RightInspector 关闭时不挂载，禁止隐藏态随选文件空跑'
  );

  const inspectorSrc = readSrc('components/RightInspector.tsx');
  assert.ok(
    inspectorSrc.includes('packages ?? groupFilesIntoPackages(files)'),
    'RightInspector 须优先复用外部传入的 packages'
  );
});

test('LeftSidebar 5,000 份文件首屏渲染保持高速且高密目录统计准确', () => {
  const files: FileRecord[] = [];
  for (let d = 0; d < 25; d += 1) {
    const folder = `02_工程/辩论赛/dir_${String(d).padStart(2, '0')}`;
    for (let i = 0; i < 200; i += 1) {
      const id = `f_${d}_${i}`;
      const title = `${String(i + 1).padStart(3, '0')}.jpg`;
      files.push({
        file_id: id,
        relative_path: `${folder}/${title}`,
        title,
        format: 'jpg',
        folder,
        role: '素材',
        roleProvenance: '来自路径',
        topics: [],
        current_revision_id: `r_${id}`,
        coverage: 'filename_only',
        revisions: [
          {
            revision_id: `r_${id}`,
            versionNumber: 1,
            observed_at: '2026-11-24T10:00:00Z',
            sizeBytes: 35000,
            snapshotAvailable: true,
          },
        ],
      } as unknown as FileRecord);
    }
  }

  const t0 = performance.now();
  const html = renderToStaticMarkup(
    React.createElement(LeftSidebar, {
      files,
      readingStates: {},
      activeFileId: 'f_0_0',
      filters: { quickScope: 'all', folder: 'all', format: 'all', role: 'all', topic: 'all' },
      onUpdateFilters: () => {},
      onResetFilters: () => {},
      onOpenFileToRead: () => {},
    })
  );
  const dt = performance.now() - t0;
  assert.ok(html.includes('02_工程'));
  assert.ok(html.includes('5000'));
  assert.ok(dt < 1200, `LeftSidebar(5000) SSR 耗时 ${dt.toFixed(1)}ms 过高`);
});
