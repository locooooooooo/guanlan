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
  expandedProjectsAfterActivate,
  filterMovableFolderTargets,
  formatMiddleEllipsisPath,
  isFolderMoveBlocked,
  SIDEBAR_WIDTH_MAX,
  SIDEBAR_WIDTH_MIN,
} from './sidebarTree';
import { projectSearchHitsToItems } from './crossWorkspaceSearch';
import { LeftSidebar } from '../components/LeftSidebar';
import { TopHeader } from '../components/TopHeader';
import { DirOpsModal } from '../components/DirOpsModal';
import { AddProjectModal } from '../components/AddProjectModal';
import { MultiProjectOverviewStrip } from '../components/MultiProjectOverviewStrip';
import { EMPTY_WORKSPACE_CONFIG } from '../stores/useWorkspaceStore';
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

test('多项目 SSR：LeftSidebar 仅展示当前单项目，切换入口在 TopHeader 下拉 + AddProjectModal + MultiProjectOverviewStrip', () => {
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
      onToggleGlobalPin: noop,
      onOpenGlobalPin: noop,
    })
  );
  assert.ok(sidebarHtml.includes('data-active-project-tree'), '左侧单项目目录树根节点');
  assert.ok(!sidebarHtml.includes('data-multi-project-tree'), '左侧不再渲染平级多项目列表');
  assert.ok(sidebarHtml.includes('data-project-node="proj_a"'), '仅展示当前激活项目 Alpha');
  assert.ok(!sidebarHtml.includes('data-project-node="proj_b"'), '不展示非激活项目 Beta');
  assert.ok(!sidebarHtml.includes('data-add-project-btn'), '左侧目录头不再放置添加项目按钮');
  assert.ok(sidebarHtml.includes('docs'), '当前项目目录树直接展开可见');
  assert.ok(sidebarHtml.includes('beta-note'), '跨项目置顶条目依然可直达');

  const switchedSidebarHtml = renderToStaticMarkup(
    React.createElement(LeftSidebar, {
      files: [makeFile('beta_doc', 'beta_docs')],
      realFolders: ['beta_docs'],
      readingStates: {},
      activeFileId: 'beta_doc',
      filters: { quickScope: 'all', folder: 'all', format: 'all', role: 'all', topic: 'all' },
      onUpdateFilters: noop,
      onResetFilters: noop,
      onOpenFileToRead: noop,
      projects,
      activeProjectId: 'proj_b',
    })
  );
  assert.ok(switchedSidebarHtml.includes('data-project-node="proj_b"'), '切换后仅展示新聚焦项目 Beta');
  assert.ok(!switchedSidebarHtml.includes('data-project-node="proj_a"'), '切换后旧项目 Alpha 不再留在左侧');
  assert.ok(switchedSidebarHtml.includes('beta_docs'), '切换后展示新聚焦项目的目录树');

  const offlineSidebarHtml = renderToStaticMarkup(
    React.createElement(LeftSidebar, {
      files: [],
      realFolders: [],
      readingStates: {},
      activeFileId: '',
      filters: { quickScope: 'all', folder: 'all', format: 'all', role: 'all', topic: 'all' },
      onUpdateFilters: noop,
      onResetFilters: noop,
      onOpenFileToRead: noop,
      projects: [{ ...projects[0], status: 'offline', error: '目录已离线' }],
      activeProjectId: 'proj_a',
    })
  );
  assert.ok(offlineSidebarHtml.includes('离线'), '离线项目标注离线状态');
  assert.ok(offlineSidebarHtml.includes('目录已离线'), '离线项目如实显示错误说明');

  const headerHtml = renderToStaticMarkup(
    React.createElement(TopHeader, {
      activeTab: 'home',
      onSelectTab: noop,
      searchQuery: '',
      onSearchChange: noop,
      searchHits: [],
      onSelectSearchHit: noop,
      unreadFilesCount: 0,
      contextBasketCount: 0,
      eventCount: 0,
      decisions: [],
      onOpenDecision: noop,
      config: { ...EMPTY_WORKSPACE_CONFIG, rootPath: 'H:\\alpha' },
      dataSource: 'real',
      scanSummary: '',
      dataError: null,
      files: [],
      sidebarFilters: { quickScope: 'all', folder: 'all', format: 'all', role: 'all', topic: 'all' },
      onUpdateSidebarFilters: noop,
      onResetSidebarFilters: noop,
      libraryMode: 'read',
      onLibraryModeChange: noop,
      onOpenSettings: noop,
      onOpenMcpConsole: noop,
      onOpenContextDrawer: noop,
      managedProjects: projects,
      activeProjectId: 'proj_a',
      onActivateProject: noop,
      onOpenAddProject: noop,
      onRemoveManagedProject: noop,
    })
  );
  assert.ok(headerHtml.includes('data-workspace-switcher'), '顶栏保留项目切换下拉入口');
  assert.ok(headerHtml.includes('项目 Alpha'), '顶栏下拉触发器展示当前聚焦项目名');
  assert.ok(headerHtml.includes('共 2 个项目，点击下拉切换'), '顶栏提示从下拉切换多项目');

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
  assert.ok(modalHtml.includes('顶部项目下拉'), '添加项目弹窗文案指向顶部下拉切换');

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


test('切换聚焦项目：旧聚焦项目收起、新聚焦项目展开，手动展开的其他项目保持', () => {
  assert.deepEqual(
    expandedProjectsAfterActivate(new Set(['alpha', 'gamma']), 'alpha', 'beta').sort(),
    ['beta', 'gamma'],
    '旧聚焦 alpha 收起，新聚焦 beta 展开，手动展开的 gamma 保持'
  );
  assert.deepEqual(
    expandedProjectsAfterActivate(new Set(['alpha', 'beta']), 'alpha', 'beta').sort(),
    ['beta'],
    '新项目已展开时也要收起旧聚焦项目'
  );
  assert.deepEqual(
    expandedProjectsAfterActivate(new Set(), '', 'beta'),
    ['beta'],
    '首次激活只展开新项目'
  );
  assert.deepEqual(
    expandedProjectsAfterActivate(new Set(['alpha']), 'alpha', ''),
    [],
    '无新聚焦项目时不展开任何项目'
  );
});

test('formatMiddleEllipsisPath：深层路径中段省略，保留首段与末级目录/文件名', () => {
  assert.equal(
    formatMiddleEllipsisPath('docs/subsystems/frontend-app.md', 34),
    'docs/subsystems/frontend-app.md'
  );
  assert.equal(
    formatMiddleEllipsisPath('native\\crates\\guanlan-core\\src\\application\\mod.rs', 34),
    'native/…/src/application/mod.rs'
  );
  assert.equal(
    formatMiddleEllipsisPath(
      'native/crates/guanlan-core/src/application/bootstrap_tests.rs',
      34
    ),
    '…/application/bootstrap_tests.rs'
  );
  assert.equal(formatMiddleEllipsisPath('README.md', 34), 'README.md');
});

