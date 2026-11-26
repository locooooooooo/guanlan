
import React, { useMemo, useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  Folder,
  FolderOpen,
  HardDrive,
  Loader2,
  Plus,
} from 'lucide-react';
import type { MountedFileEntryDto, MountedWorkspaceDto } from '../../services/apiTypes';
import type { MountedTreeCacheEntry } from '../../hooks/useDirectoryShell';
import { buildMountedFolderTree, type MountedFolderNode } from '../../utils/sidebarTree';
import { formatUiMeta } from '../../utils/formatMeta';

export interface MountedWorkspacesSectionProps {
  mounts: MountedWorkspaceDto[];
  mountedTrees: Record<string, MountedTreeCacheEntry>;
  onExpandMount: (mountId: string) => void;
  onOpenMountedFile: (fileId: string, revisionId: string) => void;
  onOpenMountManager: () => void;
}

const ROW_CLS =
  'w-full flex items-center gap-1.5 px-2 py-1 rounded-[9px] border border-transparent text-[length:var(--text-ui)] leading-[var(--lh-ui)] text-[color:var(--ink-soft)] hover:bg-white/75 hover:text-[color:var(--ink-strong)] cursor-pointer motion-safe:transition-colors';

const MountedTreeRows: React.FC<{
  nodes: MountedFolderNode[];
  depth: number;
  expanded: Set<string>;
  onToggle: (key: string) => void;
  onOpenFile: (fileId: string, revisionId: string) => void;
}> = ({ nodes, depth, expanded, onToggle, onOpenFile }) => (
  <>
    {nodes.map((node) => {
      const open = expanded.has(node.path);
      const expandable = node.children.length > 0 || node.directFiles.length > 0;
      return (
        <React.Fragment key={node.path}>
          <button
            type="button"
            onClick={() => expandable && onToggle(node.path)}
            className={ROW_CLS}
            title={`只读挂载目录：${node.path}/（共 ${node.total} 份）`}
          >
            {Array.from({ length: depth }).map((_, i) => (
              <span
                key={i}
                className="w-2.5 self-stretch shrink-0 border-l border-[color:var(--glass-hairline)]"
              />
            ))}
            <span className="w-3.5 h-3.5 shrink-0 flex items-center justify-center text-[color:var(--ink-faint)]">
              {expandable ? (
                open ? (
                  <ChevronDown className="w-3 h-3" />
                ) : (
                  <ChevronRight className="w-3 h-3" />
                )
              ) : null}
            </span>
            {open ? (
              <FolderOpen className="w-3.5 h-3.5 shrink-0 text-[color:var(--ink-faint)]" />
            ) : (
              <Folder className="w-3.5 h-3.5 shrink-0 text-[color:var(--ink-faint)]" />
            )}
            <span className="flex-1 min-w-0 text-left truncate text-[12px]">{node.name}</span>
            {node.total > 0 && (
              <span className="font-mono text-[10px] tabular-nums text-[color:var(--ink-soft)] opacity-75 shrink-0">
                {node.total}
              </span>
            )}
          </button>
          {open && (
            <>
              <MountedTreeRows
                nodes={node.children}
                depth={depth + 1}
                expanded={expanded}
                onToggle={onToggle}
                onOpenFile={onOpenFile}
              />
              {node.directFiles.map((file) => (
                <MountedFileRow
                  key={file.file_id}
                  file={file}
                  depth={depth + 1}
                  onOpenFile={onOpenFile}
                />
              ))}
            </>
          )}
        </React.Fragment>
      );
    })}
  </>
);

const MountedFileRow: React.FC<{
  file: MountedFileEntryDto;
  depth: number;
  onOpenFile: (fileId: string, revisionId: string) => void;
}> = ({ file, depth, onOpenFile }) => {
  const uiMeta = formatUiMeta(file.format);
  return (
    <button
      type="button"
      data-mounted-file={file.file_id}
      onClick={() => onOpenFile(file.file_id, file.current_revision_id)}
      title={`只读预览：${file.relative_path}`}
      className={ROW_CLS}
    >
      {Array.from({ length: depth }).map((_, i) => (
        <span
          key={i}
          className="w-2.5 self-stretch shrink-0 border-l border-[color:var(--glass-hairline)]"
        />
      ))}
      <span className="w-3.5 shrink-0 flex items-center justify-center">
        <span
          aria-hidden="true"
          className="size-1.5 rounded-full shrink-0"
          style={{ backgroundColor: uiMeta.dotColor }}
        />
      </span>
      <span className="flex-1 min-w-0 text-left truncate text-[12px]">{file.title}</span>
      <span className="shrink-0 font-mono text-[10px] text-[color:var(--ink-soft)] opacity-70">
        {uiMeta.label}
      </span>
    </button>
  );
};

const SingleMountedWorkspace: React.FC<{
  mount: MountedWorkspaceDto;
  cache?: MountedTreeCacheEntry;
  onExpandMount: (mountId: string) => void;
  onOpenMountedFile: (fileId: string, revisionId: string) => void;
}> = ({ mount, cache, onExpandMount, onOpenMountedFile }) => {
  const [open, setOpen] = useState(false);
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set());

  const tree = useMemo(() => {
    if (!cache?.data) return null;
    return buildMountedFolderTree(cache.data.items, cache.data.folders);
  }, [cache?.data]);

  const handleToggle = () => {
    const next = !open;
    setOpen(next);
    if (next && mount.online) {
      onExpandMount(mount.mount_id);
    }
  };

  const toggleDir = (path: string) => {
    setExpandedDirs((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  return (
    <div data-mounted-workspace={mount.mount_id}>
      <button
        type="button"
        onClick={handleToggle}
        className={ROW_CLS}
        title={
          mount.online
            ? `${mount.root_path}（只读挂载 · ${mount.file_count} 份文件）`
            : `${mount.root_path} · 离线：${mount.error || '索引不可达'}`
        }
      >
        <span className="w-4 h-4 shrink-0 flex items-center justify-center text-[color:var(--ink-faint)]">
          {open ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
        </span>
        <HardDrive className="w-3.5 h-3.5 shrink-0 text-[color:var(--ink-faint)]" />
        <span className="flex-1 min-w-0 text-left truncate font-medium text-[color:var(--ink-strong)]">
          {mount.name}
        </span>
        <span
          aria-hidden="true"
          className={`size-1.5 rounded-full shrink-0 ${
            mount.online ? 'bg-[color:var(--accent-iris-deep)]' : 'bg-[color:var(--ink-faint)] opacity-45'
          }`}
        />
        <span className="font-mono text-[10px] tabular-nums text-[color:var(--ink-soft)] shrink-0">
          {mount.file_count}
        </span>
      </button>

      {open && (
        <div className="pl-2 mt-0.5 space-y-0.5">
          {!mount.online ? (
            <div className="px-3 py-1.5 text-[length:var(--text-micro)] text-[color:var(--ink-soft)]">
              离线只读挂载：{mount.error || '目录或索引不可达'}
            </div>
          ) : cache?.loading && !tree ? (
            <div className="px-3 py-1.5 flex items-center gap-1.5 text-[length:var(--text-micro)] text-[color:var(--ink-soft)]">
              <Loader2 className="w-3 h-3 animate-spin" />
              <span>正在读取目录树…</span>
            </div>
          ) : cache?.error && !tree ? (
            <div className="px-3 py-1.5 text-[length:var(--text-micro)] text-[color:var(--stage-ink-exec-text)]">
              {cache.error}
            </div>
          ) : tree ? (
            <>
              <MountedTreeRows
                nodes={tree.nodes}
                depth={1}
                expanded={expandedDirs}
                onToggle={toggleDir}
                onOpenFile={onOpenMountedFile}
              />
              {tree.rootFiles.map((file) => (
                <MountedFileRow
                  key={file.file_id}
                  file={file}
                  depth={1}
                  onOpenFile={onOpenMountedFile}
                />
              ))}
              {tree.nodes.length === 0 && tree.rootFiles.length === 0 && (
                <div className="px-3 py-1 text-[length:var(--text-micro)] text-[color:var(--ink-faint)]">
                  该参考工作区暂无文件
                </div>
              )}
            </>
          ) : null}
        </div>
      )}
    </div>
  );
};

export const MountedWorkspacesSection: React.FC<MountedWorkspacesSectionProps> = ({
  mounts,
  mountedTrees,
  onExpandMount,
  onOpenMountedFile,
  onOpenMountManager,
}) => {
  return (
    <section
      data-mounted-workspaces-section=""
      className="mt-2 pt-2 border-t border-[color:var(--glass-hairline)] quiet-sep"
    >
      <div className="group/mhdr flex items-center justify-between px-2 py-1 text-[length:var(--text-micro)] leading-[var(--lh-micro)] font-semibold tracking-wider text-[color:var(--ink-soft)]">
        <span className="flex items-center gap-1.5 min-w-0 truncate">
          <HardDrive className="w-3 h-3 text-[color:var(--ink-faint)] shrink-0" />
          <span className="truncate">挂载目录</span>
          {mounts.length > 0 && (
            <span className="font-mono text-[10px] tabular-nums opacity-75">{mounts.length}</span>
          )}
        </span>
        <button
          type="button"
          data-open-mount-manager-btn=""
          onClick={onOpenMountManager}
          title="挂载或管理只读参考工作区"
          aria-label="管理挂载目录"
          className="w-5 h-5 rounded-[6px] flex items-center justify-center text-[color:var(--ink-soft)] hover:bg-white/80 hover:text-[color:var(--ink-strong)] cursor-pointer transition-colors"
        >
          <Plus className="w-3.5 h-3.5" />
        </button>
      </div>

      {mounts.length === 0 ? (
        <button
          type="button"
          onClick={onOpenMountManager}
          className="w-full flex items-center gap-1.5 px-2.5 py-1.5 rounded-[9px] text-left text-[length:var(--text-micro)] text-[color:var(--ink-faint)] hover:bg-white/65 hover:text-[color:var(--ink-soft)] cursor-pointer transition-colors"
        >
          <Plus className="w-3 h-3 shrink-0" />
          <span className="truncate">挂载其他观澜目录（只读浏览）…</span>
        </button>
      ) : (
        <div className="space-y-0.5 mt-0.5">
          {mounts.map((mount) => (
            <SingleMountedWorkspace
              key={mount.mount_id}
              mount={mount}
              cache={mountedTrees[mount.mount_id]}
              onExpandMount={onExpandMount}
              onOpenMountedFile={onOpenMountedFile}
            />
          ))}
        </div>
      )}
    </section>
  );
};
