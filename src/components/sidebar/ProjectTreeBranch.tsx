
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ChevronRight,
  FilePlus,
  Folder,
  FolderOpen,
  FolderPlus,
  Loader2,
  Pin,
} from 'lucide-react';
import type { ProjectEntryDto, ProjectTreeFileEntryDto } from '../../services/apiTypes';
import type { ProjectTreeCacheEntry } from '../../hooks/useMultiProjects';
import {
  buildProjectFolderTree,
  computeSiblingSharedPrefixMap,
  formatMiddleEllipsisName,
  type GlobalPinnedFile,
  type ProjectFolderNode,
} from '../../utils/sidebarTree';
import { formatUiMeta } from '../../utils/formatMeta';
import {
  computeVirtualWindowSlice,
  SIDEBAR_FILE_SLICE_THRESHOLD,
  SIDEBAR_VIRTUAL_ROW_HEIGHT_PX,
  SIDEBAR_VIRTUAL_VIEWPORT_PX,
} from '../../utils/virtualSlice';

export interface ProjectTreeBranchProps {
  project: ProjectEntryDto;
  cache?: ProjectTreeCacheEntry;
  inlineCreate: { parentDir: string; kind: 'folder' | 'doc' } | null;
  inlineCreateBusy: boolean;
  onStartInlineCreate?: (parentDir: string, kind: 'folder' | 'doc') => void;
  onSubmitInlineCreate?: (name: string) => void;
  onCancelInlineCreate?: () => void;
  onOpenFolder: (projectId: string, folderPath: string) => void;
  onOpenFile: (projectId: string, fileId: string) => void;
  onToggleGlobalPin?: (item: GlobalPinnedFile) => void;
  globalPinnedKeys?: ReadonlySet<string>;
}

const ROW_CLS =
  'w-full flex items-center gap-1 px-2 py-1 rounded-[9px] border border-transparent text-[length:var(--text-ui)] leading-[var(--lh-ui)] text-[color:var(--ink-soft)] hover:bg-card/75 hover:text-[color:var(--ink-strong)] cursor-pointer motion-safe:transition-colors';

/**
 * 侧栏共享「高密目录」阈值：直接子文件 >= 15 份即启用视觉降噪
 * （格式点隐去 + 行尾聚合数字微标），避免大量同类格式圆点刷屏。
 *
 * 定义在本低层分支模块：LeftSidebar 单向 import 本模块（无循环依赖），
 * 两侧共用同一阈值，保证主树与多项目副树口径一致。
 */
export const SIDEBAR_DENSE_FOLDER_THRESHOLD = 15;

const TREE_ROW_ENTER = 'glx-tree-row-in';

const getProjectTreeFileKey = (file: ProjectTreeFileEntryDto): string => file.file_id;
const projectSiblingPrefixCache = new WeakMap<
  readonly ProjectTreeFileEntryDto[],
  Map<string, number>
>();

function getCachedProjectSiblingPrefixMap(
  files: readonly ProjectTreeFileEntryDto[]
): Map<string, number> | null {
  if (files.length <= 1) return null;
  let cached = projectSiblingPrefixCache.get(files);
  if (!cached) {
    cached = computeSiblingSharedPrefixMap(files.map((f) => f.title));
    projectSiblingPrefixCache.set(files, cached);
  }
  return cached;
}

/**
 * 左栏高密目录直接子文件轻量视窗切片容器（> 150 条自动切片，维持 60fps 滚动）：
 * - 直接子文件 <= 150 份时零包裹直接渲染；
 * - 直接子文件 > 150 份时启用固定行高视窗虚拟切片，单帧仅渲染视窗内 + 缓冲项（~35 项），
 *   即使 5,500 份文件全展开亦保持流畅滚动。
 */
export function VirtualFileSlice<T>({
  items,
  renderItem,
  getKey,
  activeKey,
  rowHeight = SIDEBAR_VIRTUAL_ROW_HEIGHT_PX,
  viewportHeight = SIDEBAR_VIRTUAL_VIEWPORT_PX,
  threshold = SIDEBAR_FILE_SLICE_THRESHOLD,
}: {
  items: readonly T[];
  renderItem: (item: T, index: number) => React.ReactNode;
  getKey: (item: T) => string;
  activeKey?: string;
  rowHeight?: number;
  viewportHeight?: number;
  threshold?: number;
}): React.ReactElement {
  const [scrollTop, setScrollTop] = useState(0);
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!activeKey || items.length <= threshold) return;
    const el = containerRef.current;
    if (!el) return;
    const idx = items.findIndex((item) => getKey(item) === activeKey);
    if (idx < 0) return;
    const targetTop = Math.max(0, idx * rowHeight - Math.floor(viewportHeight / 2));
    if (Math.abs(el.scrollTop - targetTop) > viewportHeight * 0.45) {
      el.scrollTop = targetTop;
      setScrollTop(targetTop);
    }
  }, [activeKey, items, threshold, rowHeight, viewportHeight, getKey]);

  const slice = computeVirtualWindowSlice({
    totalCount: items.length,
    scrollTop,
    viewportHeight,
    rowHeight,
    threshold,
  });

  if (!slice.virtualized) {
    return (
      <>
        {items.map((item, idx) => (
          <React.Fragment key={getKey(item)}>{renderItem(item, idx)}</React.Fragment>
        ))}
      </>
    );
  }

  const visibleItems = items.slice(slice.startIndex, slice.endIndex);

  return (
    <div
      data-virtual-file-slice="active"
      data-total-files={items.length}
      data-rendered-files={visibleItems.length}
      className="my-0.5 rounded-[10px] border border-border/60 bg-muted/20"
    >
      <div
        data-virtual-slice-badge=""
        className="flex items-center justify-between gap-2 border-b border-border/50 bg-card/75 px-2.5 py-1 font-mono text-[10px] tabular-nums text-[color:var(--ink-soft)]"
      >
        <span>视窗切片 · 共 {items.length.toLocaleString('zh-CN')} 份</span>
        <span>
          #{slice.startIndex + 1}–{slice.endIndex}
        </span>
      </div>
      <div
        ref={containerRef}
        onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
        style={{ maxHeight: viewportHeight }}
        className="overflow-y-auto overscroll-contain"
      >
        {slice.topSpacerPx > 0 && (
          <div style={{ height: slice.topSpacerPx }} aria-hidden="true" />
        )}
        {visibleItems.map((item, offset) => {
          const realIdx = slice.startIndex + offset;
          return (
            <React.Fragment key={getKey(item)}>{renderItem(item, realIdx)}</React.Fragment>
          );
        })}
        {slice.bottomSpacerPx > 0 && (
          <div style={{ height: slice.bottomSpacerPx }} aria-hidden="true" />
        )}
      </div>
    </div>
  );
}

const BranchInlineCreateRow: React.FC<{
  kind: 'folder' | 'doc';
  depth: number;
  busy: boolean;
  onSubmit: (name: string) => void;
  onCancel: () => void;
}> = ({ kind, depth, busy, onSubmit, onCancel }) => {
  const [val, setVal] = useState('');
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const commit = () => {
    const trimmed = val.trim();
    if (!trimmed) {
      onCancel();
      return;
    }
    onSubmit(trimmed);
  };

  return (
    <div
      data-project-inline-create={kind}
      className="flex items-center gap-1.5 px-2 py-1 rounded-[9px] bg-card border border-[color:var(--accent-iris-deep)] shadow-sm my-0.5"
    >
      {Array.from({ length: depth }).map((_, i) => (
        <span
          key={i}
          className="w-2.5 self-stretch shrink-0 border-l border-[color:var(--glass-hairline)]"
        />
      ))}
      {kind === 'folder' ? (
        <FolderPlus className="w-3.5 h-3.5 shrink-0 text-[color:var(--accent-iris-deep)]" />
      ) : (
        <FilePlus className="w-3.5 h-3.5 shrink-0 text-[color:var(--accent-iris-deep)]" />
      )}
      <input
        ref={inputRef}
        type="text"
        disabled={busy}
        value={val}
        onChange={(e) => setVal(e.target.value)}
        placeholder={kind === 'folder' ? '新文件夹名称…' : '新文档标题 (.md)…'}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commit();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            onCancel();
          }
        }}
        onBlur={() => {
          if (!busy) commit();
        }}
        className="flex-1 min-w-0 bg-transparent text-[12px] text-[color:var(--ink-strong)] focus:outline-none"
      />
    </div>
  );
};

/** 多项目分支文件行（独立导出，便于单测校验格式点降噪与待拍板微点）。 */
export const BranchFileRow: React.FC<{
  project: ProjectEntryDto;
  file: ProjectTreeFileEntryDto;
  depth: number;
  pinned: boolean;
  dense?: boolean;
  rowIdx?: number;
  sharedPrefixLen?: number;
  onOpenFile: (projectId: string, fileId: string) => void;
  onToggleGlobalPin?: (item: GlobalPinnedFile) => void;
}> = ({
  project,
  file,
  depth,
  pinned,
  dense = false,
  rowIdx = 0,
  sharedPrefixLen = 0,
  onOpenFile,
  onToggleGlobalPin,
}) => {
  const uiMeta = formatUiMeta(file.format);
  const displayTitle = formatMiddleEllipsisName(file.title, sharedPrefixLen, 22);
  return (
    <div
      role="button"
      tabIndex={0}
      data-project-tree-file={`${project.project_id}:${file.file_id}`}
      onClick={() => onOpenFile(project.project_id, file.file_id)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpenFile(project.project_id, file.file_id);
        }
      }}
      title={`${project.name} / ${file.relative_path}`}
      className={`${ROW_CLS} group/pf glx-tree-row ${dense ? 'glx-tree-row-dense' : ''} ${dense ? '' : TREE_ROW_ENTER}`}
      style={
        dense
          ? undefined
          : ({ '--glx-tree-idx': Math.min(rowIdx, 12) } as React.CSSProperties)
      }
    >
      {Array.from({ length: depth }).map((_, i) => (
        <span
          key={i}
          className="w-2.5 self-stretch shrink-0 border-l border-[color:var(--glass-hairline)]"
        />
      ))}
      {dense ? (
        <span className="w-3.5 shrink-0 flex items-center justify-center" aria-hidden="true" />
      ) : (
        <span className="w-3.5 shrink-0 flex items-center justify-center">
          <span
            aria-hidden="true"
            className="size-1.5 rounded-full shrink-0"
            style={{ backgroundColor: uiMeta.dotColor }}
          />
        </span>
      )}
      <span className="flex-1 min-w-0 text-left truncate text-[12px]" data-full-title={file.title}>
        {displayTitle}
      </span>
      {file.pending_decisions > 0 && (
        <span
          title={`${file.pending_decisions} 项待拍板`}
          className="glx-tree-pending-dot size-1 rounded-full bg-[color:var(--accent-wave)] shrink-0"
        />
      )}
      {onToggleGlobalPin && (
        <button
          type="button"
          aria-label={pinned ? `取消置顶 ${file.title}` : `置顶 ${file.title}`}
          title={pinned ? '取消跨项目置顶' : '添加到顶部「置顶」'}
          onClick={(e) => {
            e.stopPropagation();
            onToggleGlobalPin({
              projectId: project.project_id,
              projectName: project.name,
              fileId: file.file_id,
              title: file.title,
              format: file.format,
              relativePath: file.relative_path,
            });
          }}
          className={`${
            pinned ? 'flex text-[color:var(--accent-iris-deep)]' : 'hidden group-hover/pf:flex text-[color:var(--ink-faint)]'
          } w-4 h-4 rounded items-center justify-center hover:text-[color:var(--ink-strong)] shrink-0 cursor-pointer`}
        >
          <Pin className="w-3 h-3" />
        </button>
      )}
    </div>
  );
};

/** 多项目分支目录行（独立导出，便于单测校验行尾待拍板数字微标）。 */
export const BranchFolderRows: React.FC<{
  project: ProjectEntryDto;
  nodes: ProjectFolderNode[];
  depth: number;
  expanded: Set<string>;
  onToggleDir: (path: string) => void;
  inlineCreate: { parentDir: string; kind: 'folder' | 'doc' } | null;
  inlineCreateBusy: boolean;
  onStartInlineCreate?: (parentDir: string, kind: 'folder' | 'doc') => void;
  onSubmitInlineCreate?: (name: string) => void;
  onCancelInlineCreate?: () => void;
  onOpenFolder: (projectId: string, folderPath: string) => void;
  onOpenFile: (projectId: string, fileId: string) => void;
  onToggleGlobalPin?: (item: GlobalPinnedFile) => void;
  globalPinnedKeys?: ReadonlySet<string>;
}> = ({
  project,
  nodes,
  depth,
  expanded,
  onToggleDir,
  inlineCreate,
  inlineCreateBusy,
  onStartInlineCreate,
  onSubmitInlineCreate,
  onCancelInlineCreate,
  onOpenFolder,
  onOpenFile,
  onToggleGlobalPin,
  globalPinnedKeys,
}) => (
  <>
    {nodes.map((node, nodeIdx) => {
      const open = expanded.has(node.path);
      const hasExpandable = node.children.length > 0 || node.directFiles.length > 0;
      const isCreatingInside = inlineCreate?.parentDir === node.path;
      const dense = node.directFiles.length >= SIDEBAR_DENSE_FOLDER_THRESHOLD;
      const siblingPrefixMap =
        open || isCreatingInside ? getCachedProjectSiblingPrefixMap(node.directFiles) : null;
      const pendingTotal = node.directFiles.reduce(
        (sum, f) => sum + (f.pending_decisions ?? 0),
        0
      );

      return (
        <React.Fragment key={node.path}>
          <div
            data-project-tree-folder={`${project.project_id}:${node.path}`}
            className={`${ROW_CLS} group/pdir glx-tree-row ${TREE_ROW_ENTER}`}
            style={{ '--glx-tree-idx': Math.min(nodeIdx, 12) } as React.CSSProperties}
            title={`${project.name} / ${node.path}/（共 ${node.total} 份文件）`}
          >
            {Array.from({ length: depth }).map((_, i) => (
              <span
                key={i}
                className="w-2.5 self-stretch shrink-0 border-l border-[color:var(--glass-hairline)]"
              />
            ))}
            <button
              type="button"
              aria-label={open ? `收起 ${node.name}` : `展开 ${node.name}`}
              onClick={(e) => {
                e.stopPropagation();
                if (hasExpandable || isCreatingInside) onToggleDir(node.path);
              }}
              className="w-3.5 h-3.5 shrink-0 flex items-center justify-center text-[color:var(--ink-faint)] hover:text-[color:var(--ink-strong)] cursor-pointer"
            >
              {hasExpandable || isCreatingInside ? (
                <ChevronRight
                  className="w-3 h-3 glx-chevron-rot"
                  data-open={open || isCreatingInside ? 'true' : 'false'}
                />
              ) : null}
            </button>
            {open ? (
              <FolderOpen className="w-3.5 h-3.5 shrink-0 text-[color:var(--ink-faint)]" />
            ) : (
              <Folder className="w-3.5 h-3.5 shrink-0 text-[color:var(--ink-faint)]" />
            )}
            <button
              type="button"
              onClick={() => onOpenFolder(project.project_id, node.path)}
              className="flex-1 min-w-0 text-left truncate text-[12px] cursor-pointer"
            >
              {node.name}
            </button>

            {!project.readonly && onStartInlineCreate && (
              <span className="hidden group-hover/pdir:flex items-center gap-0.5 shrink-0">
                <button
                  type="button"
                  title="在此目录新建子文件夹"
                  aria-label={`在 ${node.name} 新建子文件夹`}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (!open) onToggleDir(node.path);
                    onStartInlineCreate(node.path, 'folder');
                  }}
                  className="w-4 h-4 rounded flex items-center justify-center text-[color:var(--ink-soft)] hover:bg-accent hover:text-[color:var(--ink-strong)] cursor-pointer"
                >
                  <FolderPlus className="w-3 h-3" />
                </button>
                <button
                  type="button"
                  title="在此目录新建 Markdown 文档"
                  aria-label={`在 ${node.name} 新建文档`}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (!open) onToggleDir(node.path);
                    onStartInlineCreate(node.path, 'doc');
                  }}
                  className="w-4 h-4 rounded flex items-center justify-center text-[color:var(--ink-soft)] hover:bg-accent hover:text-[color:var(--ink-strong)] cursor-pointer"
                >
                  <FilePlus className="w-3 h-3" />
                </button>
              </span>
            )}

            {node.isEmpty ? (
              <span className="font-mono text-[10px] text-[color:var(--ink-faint)] opacity-75 shrink-0 group-hover/pdir:hidden">
                空
              </span>
            ) : (
              <span className="flex items-center gap-1 shrink-0 group-hover/pdir:hidden">
                <span className="font-mono text-[10px] tabular-nums text-[color:var(--ink-soft)] opacity-75">
                  {node.total}
                </span>
                {pendingTotal > 0 && (
                  <span
                    data-project-folder-pending={pendingTotal}
                    title={`本级 ${pendingTotal} 项待拍板`}
                    className="inline-flex items-center gap-1 rounded-[var(--r-pill)] px-1 font-mono text-[10px] leading-[var(--lh-micro)] tabular-nums text-[color:var(--accent-wave)] bg-[color:var(--depth-1-bg)]"
                  >
                    <span
                      aria-hidden="true"
                      className="size-1 rounded-full bg-[color:var(--accent-wave)] shrink-0"
                    />
                    {pendingTotal}
                  </span>
                )}
              </span>
            )}
          </div>

          {(open || isCreatingInside) && (
            <>
              {isCreatingInside && onSubmitInlineCreate && onCancelInlineCreate && (
                <BranchInlineCreateRow
                  kind={inlineCreate.kind}
                  depth={depth + 1}
                  busy={inlineCreateBusy}
                  onSubmit={onSubmitInlineCreate}
                  onCancel={onCancelInlineCreate}
                />
              )}
              <BranchFolderRows
                project={project}
                nodes={node.children}
                depth={depth + 1}
                expanded={expanded}
                onToggleDir={onToggleDir}
                inlineCreate={inlineCreate}
                inlineCreateBusy={inlineCreateBusy}
                onStartInlineCreate={onStartInlineCreate}
                onSubmitInlineCreate={onSubmitInlineCreate}
                onCancelInlineCreate={onCancelInlineCreate}
                onOpenFolder={onOpenFolder}
                onOpenFile={onOpenFile}
                onToggleGlobalPin={onToggleGlobalPin}
                globalPinnedKeys={globalPinnedKeys}
              />
              <VirtualFileSlice
                items={node.directFiles}
                getKey={getProjectTreeFileKey}
                renderItem={(file, fileIdx) => (
                  <BranchFileRow
                    project={project}
                    file={file}
                    depth={depth + 1}
                    dense={dense}
                    rowIdx={fileIdx}
                    sharedPrefixLen={siblingPrefixMap?.get(file.title) ?? 0}
                    pinned={Boolean(globalPinnedKeys?.has(`${project.project_id}:${file.file_id}`))}
                    onOpenFile={onOpenFile}
                    onToggleGlobalPin={onToggleGlobalPin}
                  />
                )}
              />
            </>
          )}
        </React.Fragment>
      );
    })}
  </>
);

export const ProjectTreeBranch: React.FC<ProjectTreeBranchProps> = ({
  project,
  cache,
  inlineCreate,
  inlineCreateBusy,
  onStartInlineCreate,
  onSubmitInlineCreate,
  onCancelInlineCreate,
  onOpenFolder,
  onOpenFile,
  onToggleGlobalPin,
  globalPinnedKeys,
}) => {
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(() => new Set());

  const tree = useMemo(() => {
    if (!cache?.data) return null;
    return buildProjectFolderTree(cache.data.files, cache.data.folders);
  }, [cache?.data]);

  const toggleDir = (path: string) => {
    setExpandedDirs((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  if (project.status === 'offline' || project.status === 'root_in_use' || project.status === 'error') {
    return (
      <div className="pl-6 pr-2 py-1 text-[11px] text-[color:var(--ink-faint)]">
        {project.error || '该项目目录当前不可访问'}
      </div>
    );
  }

  return (
    <div className="pl-2 mt-0.5 space-y-0.5" data-project-branch={project.project_id}>
      {inlineCreate?.parentDir === '' && onSubmitInlineCreate && onCancelInlineCreate && (
        <BranchInlineCreateRow
          kind={inlineCreate.kind}
          depth={0}
          busy={inlineCreateBusy}
          onSubmit={onSubmitInlineCreate}
          onCancel={onCancelInlineCreate}
        />
      )}

      {cache?.loading && !tree ? (
        <div className="flex items-center gap-1.5 px-3 py-1.5 text-[11px] text-[color:var(--ink-soft)]">
          <Loader2 className="w-3 h-3 animate-spin" />
          <span>读取目录树…</span>
        </div>
      ) : cache?.error && !tree ? (
        <div className="px-3 py-1 text-[11px] text-[color:var(--stage-ink-exec-text)]">
          {cache.error}
        </div>
      ) : tree ? (
        <>
          <BranchFolderRows
            project={project}
            nodes={tree.nodes}
            depth={0}
            expanded={expandedDirs}
            onToggleDir={toggleDir}
            inlineCreate={inlineCreate}
            inlineCreateBusy={inlineCreateBusy}
            onStartInlineCreate={onStartInlineCreate}
            onSubmitInlineCreate={onSubmitInlineCreate}
            onCancelInlineCreate={onCancelInlineCreate}
            onOpenFolder={onOpenFolder}
            onOpenFile={onOpenFile}
            onToggleGlobalPin={onToggleGlobalPin}
            globalPinnedKeys={globalPinnedKeys}
          />
          {(() => {
            const rootPrefixMap = getCachedProjectSiblingPrefixMap(tree.rootFiles);
            const rootDense = tree.rootFiles.length >= SIDEBAR_DENSE_FOLDER_THRESHOLD;
            return (
              <VirtualFileSlice
                items={tree.rootFiles}
                getKey={getProjectTreeFileKey}
                renderItem={(file, fileIdx) => (
                  <BranchFileRow
                    project={project}
                    file={file}
                    depth={0}
                    dense={rootDense}
                    rowIdx={fileIdx}
                    sharedPrefixLen={rootPrefixMap?.get(file.title) ?? 0}
                    pinned={Boolean(globalPinnedKeys?.has(`${project.project_id}:${file.file_id}`))}
                    onOpenFile={onOpenFile}
                    onToggleGlobalPin={onToggleGlobalPin}
                  />
                )}
              />
            );
          })()}
          {tree.nodes.length === 0 && tree.rootFiles.length === 0 && !inlineCreate && (
            <div className="px-3 py-1.5 text-[11px] text-[color:var(--ink-faint)]">
              {project.is_scanning ? '正在建立首次索引…' : '目录为空'}
            </div>
          )}
        </>
      ) : null}
    </div>
  );
};
