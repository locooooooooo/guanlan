
import type {
  CrossProjectSearchResponseDto,
  CrossSearchResponseDto,
  MountedWorkspaceDto,
} from '../services/apiTypes';
import type { PaletteItem } from './commandPaletteResults';

/** 在线挂载区数量（离线区不参与检索） */
export function onlineMountCount(mounts: MountedWorkspaceDto[]): number {
  return mounts.filter((m) => m.online).length;
}

/** 是否需要发 cross 请求：至少一个在线挂载区才值得一次网络往返 */
export function shouldFetchCrossSearch(mounts: MountedWorkspaceDto[]): boolean {
  return onlineMountCount(mounts) > 0;
}

/**
 * 挂载区命中（CrossSearchResponse.items 中带 source_workspace 的条目）→ 面板条目。
 * 每条携带 sourceWorkspace 徽标数据（工作区名 + root_key 前 8 位短哈希）；
 * key 前缀 `cross:` 与主区 `srv:`、本地 `local:` 三层互不冲突。
 */
export function crossHitsToItems(cross: CrossSearchResponseDto, limit: number): PaletteItem[] {
  const items: PaletteItem[] = [];
  for (const hit of cross.items) {
    if (items.length >= limit) break;
    if (!hit.source_workspace) continue;
    items.push({
      kind: 'file',
      key: `cross:${hit.source_workspace.root_key}:${hit.file_id}:${hit.revision_id}`,
      title: hit.title,
      subtitle: hit.relative_path,
      format: hit.format,
      matchStrategy: hit.match_strategy,
      coverage: hit.coverage,
      fileId: hit.file_id,
      revisionId: hit.revision_id,
      relativePath: hit.relative_path,
      snippetText: hit.snippet,
      score: hit.score,
      sourceWorkspace: {
        name: hit.source_workspace.name,
        rootKey: hit.source_workspace.root_key,
      },
    });
  }
  return items;
}

/**
 * 多项目并存联合搜索（GET /api/v1/projects/search）→ 面板条目（仅取非当前激活项目，
 * 当前激活项目已由 /api/v1/search 承担；附带 projectId 支持一键秒切项目打开完整阅读器）。
 */
export function projectSearchHitsToItems(
  resp: CrossProjectSearchResponseDto,
  limit: number
): PaletteItem[] {
  const items: PaletteItem[] = [];
  for (const hit of resp.items) {
    if (items.length >= limit) break;
    if (hit.is_active) continue;
    items.push({
      kind: 'file',
      key: `proj:${hit.project_id}:${hit.file_id}:${hit.revision_id}`,
      title: hit.title,
      subtitle: hit.relative_path,
      format: hit.format,
      matchStrategy: hit.match_strategy,
      coverage: hit.coverage,
      fileId: hit.file_id,
      revisionId: hit.revision_id,
      relativePath: hit.relative_path,
      snippetText: hit.snippet,
      score: hit.score,
      projectId: hit.project_id,
      projectName: hit.project_name,
      sourceWorkspace: {
        name: hit.project_name,
        rootKey: hit.project_id,
      },
    });
  }
  return items;
}

/**
 * 三层合并（主区服务端 + 挂载区跨库 + 本地）：fileId 去重，先到先得
 * （主区条目在队首半区 → 同 id 主区优先）；合并后按 score 降序稳定排序
 * （同分 file_id 字典序，与 commandPaletteResults.mergeHits 同口径）。
 * 结果条数以 limit 收口（各层组装时已各自截断，合并层只做统一上限）。
 */
export function mergeCrossItems(
  cross: PaletteItem[],
  base: PaletteItem[],
  limit: number
): PaletteItem[] {
  const seen = new Set<string>();
  const out: PaletteItem[] = [];
  for (const item of [...base, ...cross]) {
    if (item.kind !== 'file') {
      if (item.kind === 'action' && !seen.has(item.key)) {
        seen.add(item.key);
        out.push(item);
      }
      continue;
    }
    const id = item.fileId ?? item.key;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(item);
    if (out.length >= limit) break;
  }
  out.sort(
    (a, b) =>
      b.score - a.score ||
      (a.fileId ?? '').localeCompare(b.fileId ?? '')
  );
  return out;
}
