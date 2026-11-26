
import { fileNameOf, normalizeSlashes, parentDirOf } from './fileOps';

/** 账本单步 Delta（undo 请求直接由 oldPath/newPath 反解，不存请求体）。 */
export interface FileOpEntry {
  id: number;
  kind: 'rename' | 'move';
  fileId: string;
  oldPath: string;
  newPath: string;
  mergedCount: number;
  atMs: number;
}

export interface FileOpHistoryState {
  undo: FileOpEntry[];
  redo: FileOpEntry[];
  nextId: number;
}

/** 默认保留最近 100 步。 */
export const MAX_FILE_OP_HISTORY = 100;
/** 关联合并窗口：间隔 ≤5s 的同文件同 kind 路径续接链并步。 */
export const FILE_OP_MERGE_WINDOW_MS = 5000;

export const EMPTY_FILE_OP_HISTORY: FileOpHistoryState = {
  undo: [],
  redo: [],
  nextId: 1,
};

/** 落账输入（调用方从 FileMutationResponse 取值）。 */
export interface FileOpRecordInput {
  kind: 'rename' | 'move';
  fileId: string;
  oldPath: string;
  newPath: string;
  nowMs: number;
}

export interface RecordFileOpResult {
  state: FileOpHistoryState;
  merged: boolean;
  evicted: number;
}

/**
 * 落账一步（rename/move 成功后调用）。redo 栈清空（新动作使重做分支失效）。
 * 关联合并判定：undo 栈顶与本步同 file_id 同 kind、栈顶 new_path 续接本步 old_path、
 * 间隔 ≤ FILE_OP_MERGE_WINDOW_MS → 栈顶原位扩展（oldPath 保持链首、mergedCount+1；
 * 若合并后 oldPath === newPath 净零抵消，则弹出该栈顶，绝不残留自环步）。
 */
export function recordFileOp(
  state: FileOpHistoryState,
  input: FileOpRecordInput
): RecordFileOpResult {
  const normOld = normalizeSlashes(input.oldPath);
  const normNew = normalizeSlashes(input.newPath);
  if (!input.fileId || !normOld || !normNew || normOld === normNew) {
    return { state, merged: false, evicted: 0 };
  }

  const top = state.undo.length > 0 ? state.undo[state.undo.length - 1] : null;
  const canMerge =
    top !== null &&
    top.kind === input.kind &&
    top.fileId === input.fileId &&
    top.newPath === normOld &&
    input.nowMs - top.atMs <= FILE_OP_MERGE_WINDOW_MS;

  let undo: FileOpEntry[];
  let merged = false;
  if (canMerge && top) {
    if (top.oldPath === normNew) {
      undo = state.undo.slice(0, -1);
    } else {
      const mergedTop: FileOpEntry = {
        ...top,
        newPath: normNew,
        mergedCount: top.mergedCount + 1,
        atMs: input.nowMs,
      };
      undo = [...state.undo.slice(0, -1), mergedTop];
    }
    merged = true;
  } else {
    const entry: FileOpEntry = {
      id: state.nextId,
      kind: input.kind,
      fileId: input.fileId,
      oldPath: normOld,
      newPath: normNew,
      mergedCount: 1,
      atMs: input.nowMs,
    };
    undo = [...state.undo, entry];
  }

  let evicted = 0;
  while (undo.length > MAX_FILE_OP_HISTORY) {
    undo = undo.slice(1);
    evicted += 1;
  }

  return {
    state: {
      undo,
      redo: [],
      nextId: canMerge ? state.nextId : state.nextId + 1,
    },
    merged,
    evicted,
  };
}

/** Undo/Redo 对原子文件接口的请求描述（执行方 useFileOpHistory 消费）。 */
export interface FileOpUndoRequest {
  kind: 'rename' | 'move';
  fileId: string;
  targetDir: string;
  newName: string;
}

export type FileOpPlanFailureReason =
  | 'empty'
  | 'file-missing'
  | 'path-drifted'
  | 'target-occupied';

export type FileOpPlan =
  | {
      ok: true;
      entry: FileOpEntry;
      request: FileOpUndoRequest;
      nextState: FileOpHistoryState;
    }
  | {
      ok: false;
      reason: FileOpPlanFailureReason;
      message: string;
    };

/** 守卫输入的最小文件索引快照（FileRecord 的鸭子子集）。 */
export type FileOpHistoryFiles = ReadonlyArray<{ file_id: string; relative_path: string }>;

function guardEntry(
  entry: FileOpEntry,
  files: FileOpHistoryFiles,
  expectPath: string
): FileOpPlan | null {
  const mine = files.find((f) => f.file_id === entry.fileId);
  if (!mine) {
    return {
      ok: false,
      reason: 'file-missing',
      message: '该文件已不在当前工作区索引中（可能已被移入回收站或移出工作区），撤销/重做中止',
    };
  }
  const currentNorm = normalizeSlashes(mine.relative_path);
  if (currentNorm !== expectPath) {
    return {
      ok: false,
      reason: 'path-drifted',
      message: `文件当前位置（${currentNorm}）与账本记录不一致——文件在操作后又被再次改名或移动，为不覆盖外部变更已中止`,
    };
  }
  const restorePath = expectPath === entry.newPath ? entry.oldPath : entry.newPath;
  const occupant = files.find(
    (f) => f.file_id !== entry.fileId && normalizeSlashes(f.relative_path) === restorePath
  );
  if (occupant) {
    return {
      ok: false,
      reason: 'target-occupied',
      message: `目标路径 ${restorePath} 已被其他文件（${normalizeSlashes(occupant.relative_path)}）占用，撤销/重做中止——绝不覆盖他人新文件`,
    };
  }
  return null;
}

function planFromEntry(
  entry: FileOpEntry,
  direction: 'undo' | 'redo',
  files: FileOpHistoryFiles
): FileOpPlan {
  const expectPath = direction === 'undo' ? entry.newPath : entry.oldPath;
  const guard = guardEntry(entry, files, expectPath);
  if (guard) return guard;

  const restorePath = direction === 'undo' ? entry.oldPath : entry.newPath;
  const request: FileOpUndoRequest = {
    kind: entry.kind,
    fileId: entry.fileId,
    targetDir: parentDirOf(restorePath),
    newName: fileNameOf(restorePath),
  };
  return { ok: true, entry, request, nextState: EMPTY_FILE_OP_HISTORY };
}

/**
 * 规划撤销一步（pop undo 栈顶 → 请求；nextState 仅在执行成功后由调用方提交）。
 * undo 栈空返回 { ok:false, reason:'empty' }（无写操作可撤销，调用方静默忽略）。
 */
export function planUndo(
  state: FileOpHistoryState,
  files: FileOpHistoryFiles
): FileOpPlan {
  const entry = state.undo[state.undo.length - 1];
  if (!entry) return { ok: false, reason: 'empty', message: '没有可撤销的文件操作' };
  const plan = planFromEntry(entry, 'undo', files);
  if (!plan.ok) return plan;
  return {
    ...plan,
    nextState: {
      undo: state.undo.slice(0, -1),
      redo: [...state.redo, entry],
      nextId: state.nextId,
    },
  };
}

/**
 * 规划重做一步（pop redo 栈顶 → 正向重放请求；守卫同撤销——当前路径必须等于
 * 撤销后的 oldPath，目标 newPath 被占即中止）。
 */
export function planRedo(
  state: FileOpHistoryState,
  files: FileOpHistoryFiles
): FileOpPlan {
  const entry = state.redo[state.redo.length - 1];
  if (!entry) return { ok: false, reason: 'empty', message: '没有可重做的文件操作' };
  const plan = planFromEntry(entry, 'redo', files);
  if (!plan.ok) return plan;
  return {
    ...plan,
    nextState: {
      undo: [...state.undo, entry],
      redo: state.redo.slice(0, -1),
      nextId: state.nextId,
    },
  };
}

/** 用户可读的撤销/重做动作描述（toast 文案单一出口，方向如实标注）。 */
export function describeFileOpPlan(entry: FileOpEntry, direction: 'undo' | 'redo'): string {
  const verb = direction === 'undo' ? '撤销' : '重做';
  const kindLabel = entry.kind === 'rename' ? '重命名' : '移动';
  const mergedNote = entry.mergedCount > 1 ? `（${entry.mergedCount} 步关联动作已合并）` : '';
  const from = direction === 'undo' ? entry.newPath : entry.oldPath;
  const to = direction === 'undo' ? entry.oldPath : entry.newPath;
  return `${verb}${kindLabel}${mergedNote}：${from} → ${to}`;
}
