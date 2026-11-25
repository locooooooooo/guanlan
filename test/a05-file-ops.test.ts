import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  collectWorkspaceFolderOptions,
  DEFAULT_EXCLUDED_DIRS,
  describeFileMutationSuccess,
  fileNameOf,
  formatFromFileName,
  parentDirOf,
  validateMoveInput,
  validateRenameInput,
} from '../src/utils/fileOps';
import { pruneReadingStates, type ReadingStateMap } from '../src/utils/readingStateStore';
import {
  postMoveFile,
  postRenameFile,
  postTrashFile,
  setApiBaseUrl,
} from '../src/services/workspaceClient';
import { eventKindLabel } from '../src/utils/graphEvents';
import type { FileMutationResponse } from '../src/services/apiTypes';
import type { FileRecord, ReadingState } from '../src/types/guanlan';

function makeFile(fileId: string, relativePath: string): FileRecord {
  return {
    file_id: fileId,
    relative_path: relativePath,
    title: fileNameOf(relativePath),
    format: 'md',
    folder: parentDirOf(relativePath) || '.',
    role: '说明',
    roleProvenance: '来自路径',
    topics: [],
    current_revision_id: `${fileId}_r1`,
    revisions: [],
    coverage: 'full_text',
  };
}

function makeReadingState(fileId: string, note: string): ReadingState {
  return {
    file_id: fileId,
    last_read_revision_id: `${fileId}_r1`,
    scrollPercent: 0.5,
    isFullyRead: false,
    bookmarked: true,
    personalNote: note,
    updated_at: '2026-11-18T10:00:00+08:00',
  };
}

describe('身份保真文件操作校验（fileOps.ts）', () => {
  it('validateRenameInput：放行同格式有效新名称并拒绝非法路径、保留名与格式不兼容', () => {
    const okMd = validateRenameInput('03-拍板清单.md', '01-演示专项/03-待确认事项.md', 'md');
    assert.equal(okMd.ok, true);
    if (okMd.ok) {
      assert.equal(okMd.normalizedName, '03-拍板清单.md');
      assert.equal(okMd.targetRelativePath, '01-演示专项/03-拍板清单.md');
    }

    // .markdown 兼容 md
    const okMarkdown = validateRenameInput('notes.markdown', 'notes.md', 'md');
    assert.equal(okMarkdown.ok, true);
    if (okMarkdown.ok) {
      assert.equal(okMarkdown.targetRelativePath, 'notes.markdown');
    }

    // 同名无变化被拦
    assert.equal(
      validateRenameInput('03-待确认事项.md', '01-演示专项/03-待确认事项.md', 'md').ok,
      false
    );
    // 路径穿越 / 分隔符 / 盘符 / 隐藏名 / Windows 保留名
    assert.equal(validateRenameInput('../evil.md', 'a/b.md', 'md').ok, false);
    assert.equal(validateRenameInput('sub/b.md', 'a/b.md', 'md').ok, false);
    assert.equal(validateRenameInput('C:evil.md', 'a/b.md', 'md').ok, false);
    assert.equal(validateRenameInput('.hidden.md', 'a/b.md', 'md').ok, false);
    assert.equal(validateRenameInput('CON.md', 'a/b.md', 'md').ok, false);
    assert.equal(validateRenameInput('nul.md', 'a/b.md', 'md').ok, false);
    assert.equal(validateRenameInput('bad\u0007.md', 'a/b.md', 'md').ok, false);

    // 不允许跨格式改扩展名
    assert.equal(validateRenameInput('03-拍板清单.pdf', '01-演示专项/03-待确认事项.md', 'md').ok, false);
    assert.equal(validateRenameInput('diagram.md', 'assets/diagram.svg', 'svg').ok, false);
    assert.equal(validateRenameInput('spec.svg', 'docs/spec.pdf', 'pdf').ok, false);
  });

  it('validateMoveInput：支持根/子目录移动与可选改名，拦截越界目录、隐藏目录与排除目录', () => {
    const movedNested = validateMoveInput(
      '02-归档专项/定稿',
      '01-演示专项/03-拍板清单.md',
      'md'
    );
    assert.equal(movedNested.ok, true);
    if (movedNested.ok) {
      assert.equal(movedNested.targetDir, '02-归档专项/定稿');
      assert.equal(movedNested.fileName, '03-拍板清单.md');
      assert.equal(movedNested.targetRelativePath, '02-归档专项/定稿/03-拍板清单.md');
    }

    // 移至工作区根目录（"" 或 "."）并同步改名
    const movedToRoot = validateMoveInput(
      '',
      '01-演示专项/03-拍板清单.md',
      'md',
      '00-总览.md'
    );
    assert.equal(movedToRoot.ok, true);
    if (movedToRoot.ok) {
      assert.equal(movedToRoot.targetDir, '');
      assert.equal(movedToRoot.targetRelativePath, '00-总览.md');
    }
    const movedDotRoot = validateMoveInput('.', '01-演示专项/03-拍板清单.md', 'md');
    assert.equal(movedDotRoot.ok, true);
    if (movedDotRoot.ok) {
      assert.equal(movedDotRoot.targetDir, '');
      assert.equal(movedDotRoot.targetRelativePath, '03-拍板清单.md');
    }

    // 原地不动被拦
    assert.equal(
      validateMoveInput('01-演示专项', '01-演示专项/03-拍板清单.md', 'md').ok,
      false
    );

    // 越界 / 绝对路径 / 隐藏目录 / 排除目录 / 保留名
    assert.equal(validateMoveInput('../outside', 'a/b.md', 'md').ok, false);
    assert.equal(validateMoveInput('/abs/dir', 'a/b.md', 'md').ok, false);
    assert.equal(validateMoveInput('D:/other', 'a/b.md', 'md').ok, false);
    assert.equal(validateMoveInput('.git/hooks', 'a/b.md', 'md').ok, false);
    assert.equal(validateMoveInput('.hidden/sub', 'a/b.md', 'md').ok, false);
    assert.equal(validateMoveInput('CON/sub', 'a/b.md', 'md').ok, false);
    for (const excluded of DEFAULT_EXCLUDED_DIRS) {
      assert.equal(
        validateMoveInput(`${excluded}/sub`, 'a/b.md', 'md').ok,
        false,
        `应拦截排除目录 ${excluded}`
      );
    }
  });

  it('collectWorkspaceFolderOptions：汇总根目录与各级嵌套祖先目录并去重排序', () => {
    const dirs = collectWorkspaceFolderOptions([
      { relative_path: 'README.md' },
      { relative_path: '02-归档专项/定稿/报告.md' },
      { relative_path: '01-演示专项/架构.svg' },
      { relative_path: '02-归档专项/定稿/附图.svg' },
    ]);
    assert.equal(dirs[0], '');
    assert.ok(dirs.includes('01-演示专项'));
    assert.ok(dirs.includes('02-归档专项'));
    assert.ok(dirs.includes('02-归档专项/定稿'));
    assert.equal(new Set(dirs).size, dirs.length);
  });

  it('formatFromFileName 与 describeFileMutationSuccess 口径一致', () => {
    assert.equal(formatFromFileName('A.MD'), 'md');
    assert.equal(formatFromFileName('B.markdown'), 'md');
    assert.equal(formatFromFileName('C.svg'), 'svg');
    assert.equal(formatFromFileName('D.PDF'), 'pdf');
    assert.equal(formatFromFileName('E.txt'), 'txt');

    const base: FileMutationResponse = {
      ok: true,
      operation: 'file_renamed',
      file_id: 'f_1',
      old_path: 'a/old.md',
      new_path: 'a/new.md',
      title: 'new',
      role: '说明',
      status: 'active',
      event_id: 'ev_1',
      index_generation: 3,
      trash_recoverable: false,
    };
    assert.match(describeFileMutationSuccess(base), /重命名为 a\/new\.md/);
    assert.match(
      describeFileMutationSuccess({
        ...base,
        operation: 'file_moved',
        new_path: 'b/new.md',
      }),
      /移动到 b\/new\.md/
    );
    assert.match(
      describeFileMutationSuccess({
        ...base,
        operation: 'file_trashed',
        new_path: null,
        status: 'trashed',
        trash_recoverable: true,
      }),
      /系统回收站（非永久删除）/
    );
  });
});

describe('阅读进度连续性与事件标签', () => {
  it('pruneReadingStates：移入回收站期间经 recoverable_file_ids 保留进度，还原后无缝重连', () => {
    const initial: ReadingStateMap = {
      f_keep: makeReadingState('f_keep', '继续保留'),
      f_trashed: makeReadingState('f_trashed', '回收站可还原批注'),
      f_gone: makeReadingState('f_gone', '已彻底消失'),
    };

    // 1) 重命名/移动后 file_id 保持不变，进度 100% 连续
    const afterRename = pruneReadingStates(
      initial,
      [
        makeFile('f_keep', '02-归档专项/改名后.md'),
        makeFile('f_trashed', '01-演示专项/草稿.md'),
      ],
      []
    );
    assert.equal(afterRename.f_keep?.personalNote, '继续保留');
    assert.equal(afterRename.f_trashed?.personalNote, '回收站可还原批注');
    assert.equal(afterRename.f_gone, undefined);

    // 2) f_trashed 移入系统回收站后离开 active 列表，但服务端下发 recoverable_file_ids
    const duringTrash = pruneReadingStates(
      afterRename,
      [makeFile('f_keep', '02-归档专项/改名后.md')],
      ['f_trashed']
    );
    assert.equal(duringTrash.f_keep?.personalNote, '继续保留');
    assert.equal(duringTrash.f_trashed?.personalNote, '回收站可还原批注');

    // 3) 即使工作区所有 active 文件都被移入回收站，也不可清空可恢复文件的阅读状态
    const allTrashed = pruneReadingStates(duringTrash, [], ['f_trashed']);
    assert.equal(allTrashed.f_trashed?.personalNote, '回收站可还原批注');

    // 4) 从系统回收站还原后重新回到 active 列表，原批注与书签 100% 连续
    const afterRestore = pruneReadingStates(
      duringTrash,
      [
        makeFile('f_keep', '02-归档专项/改名后.md'),
        makeFile('f_trashed', '01-演示专项/草稿.md'),
      ],
      []
    );
    assert.equal(afterRestore.f_trashed?.personalNote, '回收站可还原批注');
    assert.equal(afterRestore.f_trashed?.bookmarked, true);
  });

  it('eventKindLabel 准确映射 file_renamed / file_moved / file_trashed', () => {
    assert.equal(eventKindLabel({ kind: 'file_renamed' }), '重命名');
    assert.equal(eventKindLabel({ kind: 'file_moved' }), '移动路径');
    assert.equal(eventKindLabel({ kind: 'file_trashed' }), '移入回收站');
  });
});

describe('workspaceClient 协议往返（postRenameFile / postMoveFile / postTrashFile）', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    setApiBaseUrl('');
  });

  it('正确组装 URL、HTTP POST 与 JSON 载荷（含 trash confirm 布尔门禁）', async () => {
    setApiBaseUrl('http://127.0.0.1:43123');
    const calls: Array<{ url: string; method: string; body: unknown }> = [];

    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      calls.push({ url, method: init?.method ?? 'GET', body });

      const op = url.endsWith('/rename')
        ? 'file_renamed'
        : url.endsWith('/move')
          ? 'file_moved'
          : 'file_trashed';
      const payload: FileMutationResponse = {
        ok: true,
        operation: op,
        file_id: 'f/special',
        old_path: 'a/old.md',
        new_path: op === 'file_trashed' ? null : 'b/new.md',
        title: 'new',
        role: '说明',
        status: op === 'file_trashed' ? 'trashed' : 'active',
        event_id: 'ev_op_1',
        index_generation: 8,
        trash_recoverable: op === 'file_trashed',
      };
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;

    const r1 = await postRenameFile('f/special', 'new.md');
    assert.equal(r1.ok, true);
    assert.equal(r1.ok && r1.data.operation, 'file_renamed');

    const r2 = await postMoveFile('f/special', 'b', 'new.md');
    assert.equal(r2.ok, true);
    assert.equal(r2.ok && r2.data.operation, 'file_moved');

    const r3 = await postTrashFile('f/special', true);
    assert.equal(r3.ok, true);
    assert.equal(r3.ok && r3.data.trash_recoverable, true);

    assert.equal(calls.length, 3);
    assert.equal(calls[0].url, 'http://127.0.0.1:43123/api/v1/files/f%2Fspecial/rename');
    assert.equal(calls[0].method, 'POST');
    assert.deepEqual(calls[0].body, { new_name: 'new.md' });

    assert.equal(calls[1].url, 'http://127.0.0.1:43123/api/v1/files/f%2Fspecial/move');
    assert.equal(calls[1].method, 'POST');
    assert.deepEqual(calls[1].body, { target_dir: 'b', new_name: 'new.md' });

    assert.equal(calls[2].url, 'http://127.0.0.1:43123/api/v1/files/f%2Fspecial/trash');
    assert.equal(calls[2].method, 'POST');
    assert.deepEqual(calls[2].body, { confirm: true });
  });
});
