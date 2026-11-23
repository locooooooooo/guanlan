/**
 * C05 · 只读参考工作区挂载状态 Hook（契约 §2.5）。
 *
 * 职责：挂载列表加载（初始 + 挂载/卸载后刷新）、挂载/卸载动作、错误透出
 * （MOUNT_REJECTED / CROSS_WORKSPACE_FORBIDDEN 等确定性错误码原样上抛给 UI）。
 * 不做 SSE 联动（挂载是低频管理动作，手动刷新 + 操作后刷新足够）。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  fetchMounts,
  mountWorkspace,
  unmountWorkspace,
} from '../services/workspaceClient';
import type { MountedWorkspaceDto } from '../services/apiTypes';

export interface UseMountedWorkspacesResult {
  mounts: MountedWorkspaceDto[];
  loading: boolean;
  /** 最近一次操作的失败提示（空串 = 无错误；操作成功后清空） */
  error: string;
  /** 在线挂载区数量（离线区不参与检索） */
  onlineCount: number;
  refresh: () => Promise<void>;
  /** 挂载（返回是否成功；失败时 error 带服务端确定性原因） */
  mount: (rootPath: string) => Promise<boolean>;
  /** 卸载（返回是否成功） */
  unmount: (mountId: string) => Promise<boolean>;
}

export function useMountedWorkspaces(enabled = true): UseMountedWorkspacesResult {
  const [mounts, setMounts] = useState<MountedWorkspaceDto[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    if (!enabled) return;
    setLoading(true);
    const result = await fetchMounts();
    if (!aliveRef.current) return;
    setLoading(false);
    if (result.ok) {
      setMounts(result.data.items);
    } else {
      // 服务未就绪 / 非桌面环境：静默为空列表（挂载面板显示「读服务不可用」由 error 通道承载）
      setError(result.error || '');
    }
  }, [enabled]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const mount = useCallback(
    async (rootPath: string): Promise<boolean> => {
      setError('');
      const result = await mountWorkspace(rootPath);
      if (result.ok) {
        await refresh();
        return true;
      }
      // 确定性错误码（MOUNT_REJECTED / CONFLICT / NOT_FOUND …）原样透出给 UI
      setError(result.error || '挂载失败（读服务不可用）');
      return false;
    },
    [refresh]
  );

  const unmount = useCallback(
    async (mountId: string): Promise<boolean> => {
      setError('');
      const result = await unmountWorkspace(mountId);
      if (result.ok) {
        await refresh();
        return true;
      }
      setError(result.error || '卸载失败（读服务不可用）');
      return false;
    },
    [refresh]
  );

  const onlineCount = mounts.filter((m) => m.online).length;
  return { mounts, loading, error, onlineCount, refresh, mount, unmount };
}
