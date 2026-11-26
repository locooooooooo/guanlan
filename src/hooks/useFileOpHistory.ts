import { useCallback, useEffect, useRef, useState } from 'react';
import type { FileMutationResponse } from '../services/apiTypes';
import { postMoveFile, postRenameFile } from '../services/workspaceClient';
import {
  describeFileOpPlan,
  EMPTY_FILE_OP_HISTORY,
  planRedo,
  planUndo,
  recordFileOp,
  type FileOpHistoryFiles,
  type FileOpHistoryState,
} from '../utils/fileOpHistory';

export interface UseFileOpHistoryOptions {
  workspaceEpoch: number;
  showToast: (tone: 'ok' | 'warn' | 'error', message: string) => void;
  onApplied?: (resp: FileMutationResponse, direction: 'undo' | 'redo') => void;
}

export interface UseFileOpHistoryResult {
  recordOp: (
    kind: 'rename' | 'move',
    fileId: string,
    oldPath: string,
    newPath: string
  ) => void;
  undo: (files: FileOpHistoryFiles) => Promise<boolean>;
  redo: (files: FileOpHistoryFiles) => Promise<boolean>;
  canUndo: boolean;
  canRedo: boolean;
  busy: boolean;
  undoStackSize: number;
  redoStackSize: number;
}

export function useFileOpHistory({
  workspaceEpoch,
  showToast,
  onApplied,
}: UseFileOpHistoryOptions): UseFileOpHistoryResult {
  const [state, setState] = useState<FileOpHistoryState>(EMPTY_FILE_OP_HISTORY);
  const [busy, setBusy] = useState(false);
  const stateRef = useRef<FileOpHistoryState>(EMPTY_FILE_OP_HISTORY);
  const busyRef = useRef(false);
  const epochRef = useRef(workspaceEpoch);
  const onAppliedRef = useRef(onApplied);
  useEffect(() => {
    onAppliedRef.current = onApplied;
  });

  useEffect(() => {
    epochRef.current = workspaceEpoch;
    stateRef.current = EMPTY_FILE_OP_HISTORY;
    setState(EMPTY_FILE_OP_HISTORY);
  }, [workspaceEpoch]);

  const recordOp = useCallback(
    (kind: 'rename' | 'move', fileId: string, oldPath: string, newPath: string) => {
      if (!fileId || !oldPath || !newPath || oldPath === newPath) return;
      const result = recordFileOp(stateRef.current, {
        kind,
        fileId,
        oldPath,
        newPath,
        nowMs: Date.now(),
      });
      stateRef.current = result.state;
      if (result.evicted > 0) {
        showToast(
          'warn',
          `文件操作账本已达 100 步上限，最早 ${result.evicted} 步已按最旧丢弃`
        );
      }
      setState(result.state);
    },
    [showToast]
  );

  const apply = useCallback(
    async (direction: 'undo' | 'redo', files: FileOpHistoryFiles): Promise<boolean> => {
      if (busyRef.current) return false;
      const startEpoch = epochRef.current;
      const currentState = stateRef.current;
      const plan =
        direction === 'undo'
          ? planUndo(currentState, files)
          : planRedo(currentState, files);
      if (!plan.ok) {
        if (plan.reason !== 'empty') showToast('error', plan.message);
        return false;
      }

      busyRef.current = true;
      setBusy(true);
      try {
        const { request } = plan;
        const result =
          request.kind === 'rename'
            ? await postRenameFile(request.fileId, request.newName)
            : await postMoveFile(request.fileId, request.targetDir, request.newName);
        if (epochRef.current !== startEpoch) return false;
        if (!result.ok || !result.data) {
          showToast(
            'error',
            `${describeFileOpPlan(plan.entry, direction)}失败：${result.error || '服务端拒绝'}（账本未推进，可重试）`
          );
          return false;
        }
        stateRef.current = plan.nextState;
        setState(plan.nextState);
        onAppliedRef.current?.(result.data, direction);
        showToast('ok', `${describeFileOpPlan(plan.entry, direction)}完成`);
        return true;
      } finally {
        busyRef.current = false;
        setBusy(false);
      }
    },
    [showToast]
  );

  const undo = useCallback((files: FileOpHistoryFiles) => apply('undo', files), [apply]);
  const redo = useCallback((files: FileOpHistoryFiles) => apply('redo', files), [apply]);

  return {
    recordOp,
    undo,
    redo,
    canUndo: state.undo.length > 0,
    canRedo: state.redo.length > 0,
    busy,
    undoStackSize: state.undo.length,
    redoStackSize: state.redo.length,
  };
}
