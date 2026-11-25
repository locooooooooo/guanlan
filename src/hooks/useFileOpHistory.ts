/**
 * 文件操作 Undo/Redo 账本执行 Hook（账本状态 + 原子文件操作接口执行 + 诚实回滚）。
 *
 * 与 useFileOps（弹窗正向操作）正交互补：
 *  - 正向链：FileOpsModal / 树内拖拽 → useFileOps.submitFileOp → postRenameFile/postMoveFile；
 *    成功回调（store 的 handleFileMutationSuccess）里调 recordOp 落账；
 *  - 逆向链：Ctrl+Z / Ctrl+Shift+Z（useGlobalShortcuts）→ undo()/redo() →
 *    fileOpHistory.planUndo/planRedo 纯守卫（文件消失/路径漂移/目标被占三道诚实中止）→
 *    复用同一对原子重命名/移动接口。file_id 不裂链由服务端 rename/move 语义保证
 *    （同写事务更新 current_path 与双向 path_aliases）；
 *  - 成功后经 onApplied 同步刷新前端 fileCacheRef / publishFiles / contextPointers / 事件，
 *    绝不把逆向操作重新写回 recordOp——支持连续 3 次改名/移动后瞬间连按 3 次 Ctrl+Z。
 *
 * 失败语义（撤销绝不静默覆盖外部新文件）：
 *  - plan 失败 → 账本【原样不动】（undo/redo 栈都不推进）+ toast 如实说明原因；
 *  - API 失败（含 409 CONFLICT 目标已存在）→ nextState 不提交，条目留在原栈，
 *    toast 服务端错误原文；下次按键仍可重试。
 */
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
  /** 工作区代际：切换工作区时整账清空（路径口径跨工作区无意义，绝不跨账撤销）。 */
  workspaceEpoch: number;
  /** toast 通道（store 既有 showSystemToast）。 */
  showToast: (tone: 'ok' | 'warn' | 'error', message: string) => void;
  /** 逆向操作落盘成功后的前端缓存同步回调（更新 fileCacheRef/publishFiles/contextPointers，不回写账本）。 */
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
  /** 逆向操作执行中（防连按并发重复执行同一步）。 */
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
  // 活值镜像：同步锁 busyRef 防同帧连按并发重放；stateRef/epochRef 防旧闭包与跨工作区提交
  const stateRef = useRef<FileOpHistoryState>(EMPTY_FILE_OP_HISTORY);
  const busyRef = useRef(false);
  const epochRef = useRef(workspaceEpoch);
  const onAppliedRef = useRef(onApplied);
  useEffect(() => {
    onAppliedRef.current = onApplied;
  });

  // 工作区切换清账（同 useFileOps 弹窗态复位同款纪律）
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
        // empty = 无可撤销/重做（按键静默，不弹 toast 打扰）；其余守卫失败如实透出
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
        // 期间切换工作区：丢弃在途结果，绝不污染新工作区账本
        if (epochRef.current !== startEpoch) return false;
        if (!result.ok || !result.data) {
          // 失败自动回滚：账本原样（条目留在原栈），服务端错误如实透出
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
