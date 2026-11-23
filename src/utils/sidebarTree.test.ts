import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  buildMergedFolderTree,
  buildMountedFolderTree,
  buildProjectFolderTree,
  clampSidebarWidth,
  collectMergedFolderOptions,
  collectSubtreeFileIds,
  filterMovableFolderTargets,
  isFolderMoveBlocked,
  SIDEBAR_WIDTH_MAX,
  SIDEBAR_WIDTH_MIN,
} from './sidebarTree';
import { projectSearchHitsToItems } from './crossWorkspaceSearch';
import { LeftSidebar } from '../components/LeftSidebar';
import { DirOpsModal } from '../components/DirOpsModal';
import { AddProjectModal } from '../components/AddProjectModal';
import { MultiProjectOverviewStrip } from '../components/MultiProjectOverviewStrip';
import type { FileRecord } from '../types/guanlan';
import type {
  MountedFileEntryDto,
  MountedWorkspaceDto,
  ProjectEntryDto,
  ProjectsOverviewResponseDto,
  ProjectTreeFileEntryDto,
} from '../services/apiTypes';

const noop = (): void => {};

function makeFile(id: string, folder: string, format: FileRecord['format'] = 'md'): FileRecord {
  return {
    file_id: id,
    relative_path: folder === '.' ? `${id}.${format}` : `${folder}/${id}.${format}`,
    title: id,
    format,
    folder,
    role: '方案',
    roleProvenance: '来自路径',
    topics: [],
    current_revision_id: `rev_${id}`,
    revisions: [],
    coverage: 'full_text',
  };
}

test('buildMergedFolderTree：合并真实空目录与已索引文件，准确标注 isEmpty 并补全祖先段', () => {
  const files = [makeFile('readme', '.'), makeFile('plan', 'docs/2026')];
  const realFolders = ['empty-inbox', 'docs/2026/empty-sub', 'notes/drafts'];
  const { nodes, rootFiles } = buildMergedFolderTree(files, realFolders);

  assert.equal(rootFiles.length, 1);
  assert.equal(rootFiles[0].file_id, 'readme');

  const emptyInbox = nodes.find((n) => n.path === 'empty-inbox');
  assert.ok(emptyInbox, '空目录必须呈现');
  assert.equal(emptyInbox.isEmpty, true);
  assert.equal(emptyInbox.total, 0);

  const docs = nodes.find((n) => n.path === 'docs');
  assert.ok(docs);
  assert.equal(docs.isEmpty, false);
  assert.equal(docs.total, 1);
  const sub2026 = docs.children.find((n) => n.path === 'docs/2026');
  assert.ok(sub2026);
  const emptySub = sub2026.children.find((n) => n.path === 'docs/2026/empty-sub');
  assert.ok(emptySub);
  assert.equal(emptySub.isEmpty, true);

  assert.deepEqual(collectSubtreeFileIds(docs), ['plan']);
});

test('isFolderMoveBlocked & filterMovableFolderTargets：严格防成环（自身/当前父/任意后代/大小写无关）', () => {
  assert.equal(isFolderMoveBlocked('docs', 'docs'), true, '禁止移入自身');
  assert.equal(isFolderMoveBlocked('docs', 'docs/sub'), true, '禁止移入子目录');
  assert.equal(isFolderMoveBlocked('docs', 'Docs/Sub/Deep'), true, 'Windows 大小写无关防成环');
  assert.equal(isFolderMoveBlocked('docs', ''), true, '已在根目录时移回根为无变化落点');
  assert.equal(isFolderMoveBlocked('docs/sub', 'docs'), true, '已在 docs 下时再移入 docs 为无变化落点');
  assert.equal(isFolderMoveBlocked('docs/sub', ''), false, '子目录可以移回根目录');
  assert.equal(isFolderMoveBlocked('docs', 'archive'), false, '允许移入兄弟目录');
  assert.equal(isFolderMoveBlocked('docs', 'docs2'), false, '前缀相似但非子目录不误拦');

  const movable = filterMovableFolderTargets(
    ['docs', 'docs/sub', 'docs/sub/deep', 'archive', 'docs2'],
    'docs'
  );
  assert.deepEqual(movable, ['archive', 'docs2']);
});

test('collectMergedFolderOptions & buildMountedFolderTree & clampSidebarWidth', () => {
  const files = [makeFile('a', 'docs/spec')];
  const opts = collectMergedFolderOptions(files, ['empty-box']);
  assert.equal(opts[0], '');
  assert.ok(opts.includes('docs'));
  assert.ok(opts.includes('docs/spec'));
  assert.ok(opts.includes('empty-box'));

  const mountedItems: MountedFileEntryDto[] = [
    {
      file_id: 'mf1',
      relative_path: 'guides/intro.md',
      title: 'intro',
      format: 'md',
      folder: 'guides',
      current_revision_id: 'mrev1',
      updated_at: '2026-11-22T01:00:00Z',
    },
  ];
  const mTree = buildMountedFolderTree(mountedItems, ['empty-ref']);
  assert.equal(mTree.nodes.length, 2);
  assert.ok(mTree.nodes.some((n) => n.path === 'empty-ref'));
  assert.ok(mTree.nodes.some((n) => n.path === 'guides' && n.total === 1));

  assert.equal(clampSidebarWidth(100), SIDEBAR_WIDTH_MIN);
  assert.equal(clampSidebarWidth(999), SIDEBAR_WIDTH_MAX);
  assert.equal(clampSidebarWidth(280), 280);
});

test('LeftSidebar SSR：渲染置顶区、真实空目录、目录快捷操作栏与挂载目录区', () => {
  const files = [makeFile('a', 'docs'), makeFile('b', '.')];
  const mounts: MountedWorkspaceDto[] = [
    {
      mount_id: 'm_1234',
      mount_key: '1234',
      root_key: 'rk_1',
      root_path: 'H:/ref-project',
      name: 'ref-project',
      online: true,
      index_generation: 3,
      search_state: 'ready',
      file_count: 12,
    },
  ];
  const html = renderToStaticMarkup(
    React.createElement(LeftSidebar, {
      files,
      realFolders: ['empty-inbox', 'docs'],
      readingStates: {},
      activeFileId: 'a',
      filters: { quickScope: 'all', folder: 'all', format: 'all', role: 'all', topic: 'all' },
      onUpdateFilters: noop,
      onResetFilters: noop,
      onOpenFileToRead: noop,
      pinnedFileIds: ['a'],
      onTogglePinFile: noop,
      onCreateFolder: noop,
      onCreateDocument: noop,
      onRenameFolder: noop,
      onMoveFolder: noop,
      onBatchMoveFiles: noop,
      onBatchTrashFiles: noop,
      mounts,
      mountedTrees: {},
      onExpandMount: noop,
      onOpenMountedFile: noop,
      onOpenMountManager: noop,
    })
  );

  assert.ok(html.includes('data-global-directory-sidebar'), '全局目录侧栏根节点');
  assert.ok(html.includes('data-pinned-files-section'), '置顶分区渲染');
  assert.ok(html.includes('data-workspace-dir-header'), '工作区目录章节头');
  assert.ok(html.includes('data-create-root-folder-btn'), '新建文件夹快捷钮');
  assert.ok(html.includes('data-create-root-doc-btn'), '新建文档快捷钮');
  assert.ok(html.includes('data-toggle-batch-mode'), '批量整理开关');
  assert.ok(html.includes('data-empty-folder="true"'), '真实空目录呈现');
  assert.ok(html.includes('empty-inbox'), '空目录名展示');
  assert.ok(html.includes('data-mounted-workspaces-section'), '挂载目录分区渲染');
  assert.ok(html.includes('ref-project'), '挂载工作区名称直接可见');
});

test('DirOpsModal SSR：文件夹移动隐藏子树、回收站需勾选二次确认', () => {
  const moveHtml = renderToStaticMarkup(
    React.createElement(DirOpsModal, {
      request: { kind: 'folder-move', folderPath: 'docs' },
      folderOptions: ['', 'docs', 'docs/sub', 'archive'],
      submitting: false,
      serverError: null,
      onClose: noop,
      onSubmit: noop,
    })
  );
  assert.ok(moveHtml.includes('data-dir-ops-modal="folder-move"'));
  assert.ok(moveHtml.includes('archive'));
  assert.ok(!moveHtml.includes('>docs/sub<'), '后代目录必须隐藏');

  const trashHtml = renderToStaticMarkup(
    React.createElement(DirOpsModal, {
      request: { kind: 'folder-trash', folderPath: 'docs', affectedCount: 5 },
      folderOptions: [],
      submitting: false,
      serverError: null,
      onClose: noop,
      onSubmit: noop,
    })
  );
  assert.ok(trashHtml.includes('data-dir-ops-modal="folder-trash"'));
  assert.ok(trashHtml.includes('绝不永久删除'));
  assert.ok(trashHtml.includes('我已核对目标，确认移入系统回收站'));
});

test('buildProjectFolderTree & projectSearchHitsToItems：多项目树空目录保留与跨项目搜索映射', () => {
  const files: ProjectTreeFileEntryDto[] = [
    {
      file_id: 'fb1',
      relative_path: 'specs/design.md',
      title: 'design',
      format: 'md',
      folder: 'specs',
      current_revision_id: 'fb1_r1',
      updated_at: '2026-11-22T02:00:00Z',
      revision_count: 1,
      pending_decisions: 2,
    },
  ];
  const tree = buildProjectFolderTree(files, ['empty-box', 'specs']);
  assert.equal(tree.nodes.length, 2);
  assert.equal(tree.nodes.find((n) => n.path === 'empty-box')?.isEmpty, true);
  assert.equal(tree.nodes.find((n) => n.path === 'specs')?.total, 1);

  const mapped = projectSearchHitsToItems(
    {
      ok: true,
      query: 'design',
      total_hits: 2,
      searched_projects: 2,
      offline_projects: 0,
      items: [
        {
          project_id: 'proj_a',
          project_name: '项目 A',
          is_active: true,
          file_id: 'fa1',
          revision_id: 'fa1_r1',
          relative_path: 'a.md',
          title: 'a',
          format: 'md',
          coverage: 'full_text',
          match_strategy: 'filename_match',
          locator: { kind: 'file' },
          snippet: 'a.md',
          score: 90,
        },
        {
          project_id: 'proj_b',
          project_name: '项目 B',
          is_active: false,
          file_id: 'fb1',
          revision_id: 'fb1_r1',
          relative_path: 'specs/design.md',
          title: 'design',
          format: 'md',
          coverage: 'full_text',
          match_strategy: 'filename_match',
          locator: { kind: 'file' },
          snippet: 'specs/design.md',
          score: 85,
        },
      ],
    },
    10
  );
  assert.equal(mapped.length, 1, '仅映射非当前激活项目，避免与主区 /search 重复');
  assert.equal(mapped[0].projectId, 'proj_b');
  assert.equal(mapped[0].sourceWorkspace?.name, '项目 B');
});

test('多项目 SSR：LeftSidebar 平级多项目树 + AddProjectModal + MultiProjectOverviewStrip', () => {
  const projects: ProjectEntryDto[] = [
    {
      project_id: 'proj_a',
      name: '项目 Alpha',
      root_path: 'H:\\alpha',
      readonly: false,
      is_active: true,
      status: 'ready',
      file_count: 5,
      folder_count: 2,
      pending_decisions_count: 1,
      index_generation: 3,
      is_scanning: false,
      added_at: '2026-11-22T01:00:00Z',
      last_opened_at: '2026-11-22T02:00:00Z',
    },
    {
      project_id: 'proj_b',
      name: '项目 Beta',
      root_path: 'H:\\beta',
      readonly: false,
      is_active: false,
      status: 'ready',
      file_count: 3,
      folder_count: 2,
      pending_decisions_count: 2,
      index_generation: 2,
      is_scanning: false,
      added_at: '2026-11-22T01:00:00Z',
      last_opened_at: '2026-11-22T01:30:00Z',
    },
  ];
  const sidebarHtml = renderToStaticMarkup(
    React.createElement(LeftSidebar, {
      files: [makeFile('alpha_doc', 'docs')],
      realFolders: ['docs'],
      readingStates: {},
      activeFileId: 'alpha_doc',
      filters: { quickScope: 'all', folder: 'all', format: 'all', role: 'all', topic: 'all' },
      onUpdateFilters: noop,
      onResetFilters: noop,
      onOpenFileToRead: noop,
      projects,
      activeProjectId: 'proj_a',
      expandedProjects: new Set(['proj_a', 'proj_b']),
      projectTrees: {
        proj_b: {
          loading: false,
          data: {
            ok: true,
            project_id: 'proj_b',
            name: '项目 Beta',
            root_path: 'H:\\beta',
            readonly: false,
            is_active: false,
            status: 'ready',
            total: 1,
            truncated: false,
            folders: ['beta_empty'],
            files: [
              {
                file_id: 'beta_f1',
                relative_path: 'beta-note.md',
                title: 'beta-note',
                format: 'md',
                folder: '.',
                current_revision_id: 'beta_f1_r1',
                updated_at: '2026-11-22T02:00:00Z',
                revision_count: 1,
                pending_decisions: 1,
              },
            ],
          },
        },
      },
      globalPins: [
        {
          projectId: 'proj_b',
          projectName: '项目 Beta',
          fileId: 'beta_f1',
          title: 'beta-note',
          format: 'md',
          relativePath: 'beta-note.md',
        },
      ],
      onOpenAddProject: noop,
      onToggleProjectExpanded: noop,
      onActivateProject: noop,
      onToggleGlobalPin: noop,
      onOpenGlobalPin: noop,
    })
  );
  assert.ok(sidebarHtml.includes('data-multi-project-tree'), '多项目树根节点');
  assert.ok(sidebarHtml.includes('data-project-node="proj_a"'), '包含项目 Alpha');
  assert.ok(sidebarHtml.includes('data-project-node="proj_b"'), '包含项目 Beta');
  assert.ok(sidebarHtml.includes('beta_empty'), '非激活项目真实空目录同时展开可见');
  assert.ok(sidebarHtml.includes('beta-note'), '非激活项目文件与跨项目置顶同时可见');

  const modalHtml = renderToStaticMarkup(
    React.createElement(AddProjectModal, {
      isOpen: true,
      onClose: noop,
      projects,
      onSubmit: async () => true,
    })
  );
  assert.ok(modalHtml.includes('data-add-project-modal="open"'));
  assert.ok(modalHtml.includes('添加项目文件夹'));

  const overview: ProjectsOverviewResponseDto = {
    ok: true,
    active_project_id: 'proj_a',
    total_projects: 2,
    online_projects: 2,
    total_files: 8,
    total_pending_decisions: 3,
    projects,
    pending_decisions: [
      {
        project_id: 'proj_b',
        project_name: '项目 Beta',
        decision_id: 'dec_b1',
        code: 'D-101',
        question: '是否开启多项目模式？',
        status: '待确认',
        file_id: 'beta_f1',
        relative_path: 'beta-note.md',
        title: 'beta-note',
        line_start: 5,
        observed_at: '2026-11-22T02:00:00Z',
      },
    ],
    recent_files: [],
  };
  const overviewHtml = renderToStaticMarkup(
    React.createElement(MultiProjectOverviewStrip, {
      overview,
      projects,
      activeProjectId: 'proj_a',
      onAddProject: noop,
      onFocusProject: noop,
      onOpenCrossDecision: noop,
      onOpenCrossFile: noop,
    })
  );
  assert.ok(overviewHtml.includes('data-multi-project-overview'));
  assert.ok(overviewHtml.includes('项目 Alpha'));
  assert.ok(overviewHtml.includes('项目 Beta'));
  assert.ok(overviewHtml.includes('是否开启多项目模式？'));
});

