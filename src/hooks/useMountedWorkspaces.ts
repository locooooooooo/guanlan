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
  error: string;
  onlineCount: number;
  refresh: () => Promise<void>;
  mount: (rootPath: string) => Promise<boolean>;
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
