import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  displayFolderLabel,
  normalizeRelativeWorkspacePath,
  resolveWorkspaceAbsolutePath,
  validateImportTargetDir,
} from '../src/utils/workspacePaths';
import {
  copyTextWithDesktopFallback,
  importDesktopExternalFiles,
  isDesktopSystemBridgeAvailable,
  openWithDesktopDefaultApp,
  pickDesktopExternalFiles,
  resolveDesktopAbsolutePath,
  revealInDesktopExplorer,
  subscribeNativeDragDrop,
  type NativeDragDropEvent,
} from '../src/services/desktopBridge';

describe('A04 工作区路径防线与原生系统桥接', () => {
  const originalWindow = (globalThis as { window?: unknown }).window;
  const originalNavigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');

  beforeEach(() => {
    (globalThis as unknown as { window?: unknown }).window = {};
  });

  afterEach(() => {
    (globalThis as unknown as { window?: unknown }).window = originalWindow;
    if (originalNavigatorDescriptor) {
      Object.defineProperty(globalThis, 'navigator', originalNavigatorDescriptor);
    } else {
      Reflect.deleteProperty(globalThis, 'navigator');
    }
  });

  it('100% 拦截路径穿越、盘符/UNC、NTFS 流冒号、控制符与系统保留名', () => {
    const evilInputs = [
      '../outside/secret.md',
      'docs/../../outside.pdf',
      '..',
      '.\\..\\outside',
      '/etc/passwd',
      'C:\\Windows\\System32\\cmd.exe',
      'D:/work/file.md',
      '\\\\server\\share\\file.md',
      'docs\\evil:stream.txt',
      'CON',
      'NUL.md',
      'docs/COM1.pdf',
      'LPT9',
      'docs\0evil.md',
      'docs/a\nb.md',
      'docs//empty.md',
    ];

    for (const evil of evilInputs) {
      assert.equal(
        normalizeRelativeWorkspacePath(evil, true),
        null,
        `非法路径必须被拦截：${JSON.stringify(evil)}`
      );
      assert.equal(
        resolveWorkspaceAbsolutePath('H:\\desktop-organizer\\demo', evil, true),
        null,
        `绝对路径解析必须拦截越界路径：${JSON.stringify(evil)}`
      );
    }

    assert.equal(normalizeRelativeWorkspacePath('', false), null);
    assert.equal(normalizeRelativeWorkspacePath('.', false), null);
    assert.equal(normalizeRelativeWorkspacePath('', true), '');
    assert.equal(normalizeRelativeWorkspacePath('.', true), '');
    assert.equal(normalizeRelativeWorkspacePath('docs\\inbox\\方案.md'), 'docs/inbox/方案.md');
  });

  it('正确拼接 Windows 与 POSIX 工作区绝对路径并校验导入目标目录', () => {
    assert.equal(
      resolveWorkspaceAbsolutePath('H:\\workspace\\guanlan\\', '01-需求/方案定稿.pdf'),
      'H:\\workspace\\guanlan\\01-需求\\方案定稿.pdf'
    );
    assert.equal(
      resolveWorkspaceAbsolutePath('C:\\', 'root-note.md'),
      'C:\\root-note.md'
    );
    assert.equal(
      resolveWorkspaceAbsolutePath('H:\\workspace\\guanlan', '', true),
      'H:\\workspace\\guanlan'
    );
    assert.equal(
      resolveWorkspaceAbsolutePath('/Users/demo/project/', 'docs/readme.md'),
      '/Users/demo/project/docs/readme.md'
    );
    assert.equal(resolveWorkspaceAbsolutePath('', 'docs/readme.md'), null);

    assert.deepEqual(validateImportTargetDir(''), { ok: true, normalized: '' });
    assert.deepEqual(validateImportTargetDir('inbox\\2026-11'), {
      ok: true,
      normalized: 'inbox/2026-11',
    });
    assert.equal(validateImportTargetDir('.git').ok, false);
    assert.equal(validateImportTargetDir('docs/.hidden').ok, false);
    assert.equal(validateImportTargetDir('../outside').ok, false);
    assert.equal(displayFolderLabel(''), '工作区根目录');
    assert.equal(displayFolderLabel('01-需求'), '01-需求');
  });

  it('浏览器无桌面桥时安全降级且不谎报成功', async () => {
    assert.equal(isDesktopSystemBridgeAvailable(), false);

    const reveal = await revealInDesktopExplorer('docs/readme.md');
    assert.equal(reveal.ok, false);
    if (!reveal.ok) assert.equal(reveal.code, 'NOT_DESKTOP');

    const opened = await openWithDesktopDefaultApp('docs/readme.md');
    assert.equal(opened.ok, false);
    if (!opened.ok) assert.equal(opened.code, 'NOT_DESKTOP');

    const picked = await pickDesktopExternalFiles();
    assert.equal(picked.ok, false);
    assert.deepEqual(picked.paths, []);

    const imported = await importDesktopExternalFiles(['C:\\tmp\\a.pdf'], '');
    assert.equal(imported.ok, false);
    if (!imported.ok) assert.equal(imported.code, 'NOT_DESKTOP');

    // 无桥时 resolveDesktopAbsolutePath 按工作区安全规则本地计算，越界仍返回 null
    assert.equal(
      await resolveDesktopAbsolutePath('docs/readme.md', 'H:\\demo'),
      'H:\\demo\\docs\\readme.md'
    );
    assert.equal(await resolveDesktopAbsolutePath('../secret.txt', 'H:\\demo'), null);

    // 剪贴板在无桥时回退到 navigator.clipboard
    const copiedTexts: string[] = [];
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: {
        clipboard: {
          writeText: async (txt: string) => {
            copiedTexts.push(txt);
          },
        },
      },
    });
    const copyRes = await copyTextWithDesktopFallback('H:\\demo\\docs\\readme.md');
    assert.deepEqual(copyRes, { ok: true });
    assert.deepEqual(copiedTexts, ['H:\\demo\\docs\\readme.md']);
  });

  it('桌面系统桥接就绪时正确调用定位、默认打开、剪贴板、路径解析与拖放事件订阅', async () => {
    const calls: string[] = [];
    const listeners = new Map<string, Set<(ev: Event) => void>>();

    (globalThis as unknown as { window: Record<string, unknown> }).window = {
      __GUANLAN_SYSTEM_BRIDGE__: {
        pickExternalFiles: async () => ['C:\\Users\\demo\\方案.pdf'],
        revealInExplorer: async (rel: string) => {
          calls.push(`reveal:${rel}`);
          return { ok: true, message: '已在资源管理器中显示', absolutePath: `H:\\ws\\${rel}` };
        },
        openWithDefaultApp: async (rel: string) => {
          calls.push(`open:${rel}`);
          return { ok: true, message: '已调用系统默认应用打开', absolutePath: `H:\\ws\\${rel}` };
        },
        writeClipboardText: async (text: string) => {
          calls.push(`clip:${text}`);
          if (text === 'FAIL_NATIVE') {
            throw new Error('clipboard busy');
          }
          return { ok: true, message: 'ok' };
        },
        resolveWorkspacePath: async (rel: string) => {
          calls.push(`resolve:${rel}`);
          return `H:\\ws\\${rel.replace(/\//g, '\\')}`;
        },
        importExternalFiles: async (paths: string[], targetDir: string) => {
          calls.push(`import:${targetDir}:${paths.length}`);
          return {
            ok: true,
            targetDir,
            imported: [
              {
                sourcePath: paths[0],
                relativePath: targetDir ? `${targetDir}/方案.pdf` : '方案.pdf',
                absolutePath: `H:\\ws\\${targetDir ? `${targetDir}\\` : ''}方案.pdf`,
                fileName: '方案.pdf',
                bytes: 42,
                renamed: false,
                indexedByCurrentEngine: true,
              },
            ],
            skipped: [],
            indexedRelativePaths: [targetDir ? `${targetDir}/方案.pdf` : '方案.pdf'],
            jobId: 'job-import-1',
          };
        },
      },
      addEventListener: (type: string, fn: (ev: Event) => void) => {
        if (!listeners.has(type)) listeners.set(type, new Set());
        listeners.get(type)!.add(fn);
      },
      removeEventListener: (type: string, fn: (ev: Event) => void) => {
        listeners.get(type)?.delete(fn);
      },
      dispatchEvent: (ev: { type: string }) => {
        for (const fn of listeners.get(ev.type) ?? []) {
          fn(ev as unknown as Event);
        }
        return true;
      },
    };

    assert.equal(isDesktopSystemBridgeAvailable(), true);
    const reveal = await revealInDesktopExplorer('docs/plan.md');
    assert.equal(reveal.ok, true);
    const opened = await openWithDesktopDefaultApp('docs/plan.md');
    assert.equal(opened.ok, true);
    assert.equal(await resolveDesktopAbsolutePath('docs/plan.md'), 'H:\\ws\\docs\\plan.md');
    const picked = await pickDesktopExternalFiles();
    assert.deepEqual(picked, { ok: true, paths: ['C:\\Users\\demo\\方案.pdf'] });
    const imported = await importDesktopExternalFiles(picked.paths, '01-需求');
    assert.equal(imported.ok, true);
    if (imported.ok) {
      assert.equal(imported.data.jobId, 'job-import-1');
      assert.deepEqual(imported.data.indexedRelativePaths, ['01-需求/方案.pdf']);
    }

    // 原生剪贴板优先
    const webFallbackCalls: string[] = [];
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: {
        clipboard: {
          writeText: async (t: string) => {
            webFallbackCalls.push(t);
          },
        },
      },
    });
    assert.deepEqual(await copyTextWithDesktopFallback('01-需求/方案.pdf'), { ok: true });
    assert.deepEqual(webFallbackCalls, []);
    // 原生失败时安全回退 Web 剪贴板
    assert.deepEqual(await copyTextWithDesktopFallback('FAIL_NATIVE'), { ok: true });
    assert.deepEqual(webFallbackCalls, ['FAIL_NATIVE']);

    // 原生拖放事件订阅与取消
    const dropEvents: NativeDragDropEvent[] = [];
    const unsubscribe = subscribeNativeDragDrop((ev) => dropEvents.push(ev));
    const winObj = (globalThis as unknown as { window: { dispatchEvent: (e: unknown) => boolean } })
      .window;
    winObj.dispatchEvent({
      type: 'guanlan:native-drag-drop',
      detail: { kind: 'enter', paths: ['C:\\a.pdf'], x: 100, y: 200 },
    });
    winObj.dispatchEvent({
      type: 'guanlan:native-drag-drop',
      detail: { kind: 'drop', paths: ['C:\\a.pdf'], x: 100, y: 200 },
    });
    unsubscribe();
    winObj.dispatchEvent({
      type: 'guanlan:native-drag-drop',
      detail: { kind: 'leave' },
    });
    assert.equal(dropEvents.length, 2);
    assert.equal(dropEvents[0].kind, 'enter');
    assert.equal(dropEvents[1].kind, 'drop');

    assert.deepEqual(calls, [
      'reveal:docs/plan.md',
      'open:docs/plan.md',
      'resolve:docs/plan.md',
      'import:01-需求:1',
      'clip:01-需求/方案.pdf',
      'clip:FAIL_NATIVE',
    ]);
  });
});
