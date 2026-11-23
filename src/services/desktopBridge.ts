import { resolveWorkspaceAbsolutePath } from '../utils/workspacePaths';

/**
 * 桌面壳工作区与原生系统桥（Tauri `window.__GUANLAN_BOOT__` /
 * `window.__GUANLAN_WORKSPACE_BRIDGE__` / `window.__GUANLAN_SYSTEM_BRIDGE__`）。
 *
 * 在浏览器 / CLI `guanlan serve` 下桥不存在，所有辅助函数按只读单工作区模式安全降级。
 */

export interface RecentWorkspaceStatus {
  root: string;
  name: string;
  lastOpenedAt: string;
  exists: boolean;
}

export interface DesktopBridgeError {
  code: 'ROOT_IN_USE' | 'NOT_FOUND' | 'INTERNAL' | string;
  message: string;
  root: string;
  dataDir?: string | null;
  lockFilePath?: string | null;
  lockInfo?: string | null;
}

export interface DesktopSessionState {
  status: 'ready' | 'unconfigured' | 'root_in_use' | 'error';
  endpoint: string;
  root: string | null;
  workspaceName: string | null;
  recentWorkspaces: RecentWorkspaceStatus[];
  previousRoot?: string | null;
  error?: DesktopBridgeError | null;
}

interface DesktopWorkspaceBridge {
  getState: () => Promise<DesktopSessionState>;
  pickFolder: () => Promise<string | null>;
  switchWorkspace: (root: string) => Promise<DesktopSessionState>;
  removeRecentWorkspace: (root: string) => Promise<RecentWorkspaceStatus[]>;
}

interface DesktopSystemBridge {
  pickExternalFiles: () => Promise<string[]>;
  revealInExplorer: (
    relativePath: string
  ) => Promise<{ ok: boolean; message: string; absolutePath?: string | null }>;
  openWithDefaultApp: (
    relativePath: string
  ) => Promise<{ ok: boolean; message: string; absolutePath?: string | null }>;
  writeClipboardText: (text: string) => Promise<{ ok: boolean; message: string }>;
  resolveWorkspacePath: (relativePath: string) => Promise<string>;
  importExternalFiles: (
    sourcePaths: string[],
    targetDir: string
  ) => Promise<ImportExternalFilesData>;
}

export interface ImportedFileEntry {
  sourcePath: string;
  relativePath: string;
  absolutePath: string;
  fileName: string;
  bytes: number;
  renamed: boolean;
  indexedByCurrentEngine: boolean;
}

export interface SkippedImportEntry {
  sourcePath: string;
  reason: string;
}

export interface ImportExternalFilesData {
  ok: boolean;
  targetDir: string;
  imported: ImportedFileEntry[];
  skipped: SkippedImportEntry[];
  indexedRelativePaths: string[];
  jobId?: string | null;
}

export type SystemBridgeActionOutcome =
  | { ok: true; message: string; absolutePath?: string | null }
  | { ok: false; code: string; error: string };

export type ImportExternalFilesOutcome =
  | { ok: true; data: ImportExternalFilesData }
  | { ok: false; code: string; error: string };

export type NativeDragDropEvent =
  | { kind: 'enter'; paths: string[]; x: number; y: number }
  | { kind: 'over'; x: number; y: number }
  | { kind: 'drop'; paths: string[]; x: number; y: number }
  | { kind: 'leave' };

interface GuanlanDesktopGlobals {
  __GUANLAN_DESKTOP__?: boolean;
  __GUANLAN_BOOT__?: DesktopSessionState;
  __GUANLAN_WORKSPACE_BRIDGE__?: DesktopWorkspaceBridge;
  __GUANLAN_SYSTEM_BRIDGE__?: DesktopSystemBridge;
}

function globals(): GuanlanDesktopGlobals {
  return (typeof window !== 'undefined' ? window : {}) as unknown as GuanlanDesktopGlobals;
}

function parseBridgeError(err: unknown): { code: string; message: string } {
  if (err && typeof err === 'object' && 'message' in err) {
    const code =
      'code' in err && typeof (err as { code?: unknown }).code === 'string'
        ? (err as { code: string }).code
        : 'INTERNAL';
    const message =
      typeof (err as { message?: unknown }).message === 'string'
        ? (err as { message: string }).message
        : String(err);
    return { code, message };
  }
  return { code: 'INTERNAL', message: err instanceof Error ? err.message : String(err) };
}

export function isDesktopWorkspaceBridgeAvailable(): boolean {
  const g = globals();
  return Boolean(g.__GUANLAN_WORKSPACE_BRIDGE__);
}

export function isDesktopSystemBridgeAvailable(): boolean {
  const g = globals();
  return Boolean(g.__GUANLAN_SYSTEM_BRIDGE__);
}

export function getInitialDesktopSession(): DesktopSessionState | null {
  const boot = globals().__GUANLAN_BOOT__;
  if (!boot || typeof boot !== 'object' || typeof boot.status !== 'string') {
    return null;
  }
  return boot;
}

export async function pickDesktopWorkspaceFolder(): Promise<{
  ok: boolean;
  path: string | null;
  error?: string;
}> {
  const bridge = globals().__GUANLAN_WORKSPACE_BRIDGE__;
  if (!bridge) {
    return { ok: false, path: null, error: '当前运行在浏览器模式，请从桌面端选择文件夹' };
  }
  try {
    const picked = await bridge.pickFolder();
    return { ok: true, path: picked || null };
  } catch (err) {
    return {
      ok: false,
      path: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export type SwitchWorkspaceOutcome =
  | { ok: true; state: DesktopSessionState }
  | { ok: false; error: DesktopBridgeError };

export async function switchDesktopWorkspace(root: string): Promise<SwitchWorkspaceOutcome> {
  const bridge = globals().__GUANLAN_WORKSPACE_BRIDGE__;
  if (!bridge) {
    return {
      ok: false,
      error: {
        code: 'INTERNAL',
        message: '多工作区切换需在观澜桌面客户端中使用',
        root,
      },
    };
  }
  try {
    const state = await bridge.switchWorkspace(root);
    return { ok: true, state };
  } catch (err) {
    if (err && typeof err === 'object' && 'code' in err && 'message' in err) {
      return { ok: false, error: err as DesktopBridgeError };
    }
    return {
      ok: false,
      error: {
        code: 'INTERNAL',
        message: err instanceof Error ? err.message : String(err),
        root,
      },
    };
  }
}

export async function removeRecentDesktopWorkspace(
  root: string
): Promise<RecentWorkspaceStatus[] | null> {
  const bridge = globals().__GUANLAN_WORKSPACE_BRIDGE__;
  if (!bridge) return null;
  try {
    return await bridge.removeRecentWorkspace(root);
  } catch {
    return null;
  }
}

export async function refreshDesktopSession(): Promise<DesktopSessionState | null> {
  const bridge = globals().__GUANLAN_WORKSPACE_BRIDGE__;
  if (!bridge) return null;
  try {
    return await bridge.getState();
  } catch {
    return null;
  }
}

export async function pickDesktopExternalFiles(): Promise<{
  ok: boolean;
  paths: string[];
  error?: string;
}> {
  const bridge = globals().__GUANLAN_SYSTEM_BRIDGE__;
  if (!bridge) {
    return { ok: false, paths: [], error: '仅观澜桌面客户端支持原生多文件导入选择器' };
  }
  try {
    const paths = await bridge.pickExternalFiles();
    return { ok: true, paths: Array.isArray(paths) ? paths : [] };
  } catch (err) {
    return { ok: false, paths: [], error: parseBridgeError(err).message };
  }
}

export async function revealInDesktopExplorer(
  relativePath: string
): Promise<SystemBridgeActionOutcome> {
  const bridge = globals().__GUANLAN_SYSTEM_BRIDGE__;
  if (!bridge) {
    return {
      ok: false,
      code: 'NOT_DESKTOP',
      error: '当前运行在浏览器模式，请在观澜桌面客户端中打开资源管理器定位',
    };
  }
  try {
    const res = await bridge.revealInExplorer(relativePath);
    return {
      ok: true,
      message: res.message || '已在资源管理器中显示',
      absolutePath: res.absolutePath ?? null,
    };
  } catch (err) {
    const parsed = parseBridgeError(err);
    return { ok: false, code: parsed.code, error: parsed.message };
  }
}

export async function openWithDesktopDefaultApp(
  relativePath: string
): Promise<SystemBridgeActionOutcome> {
  const bridge = globals().__GUANLAN_SYSTEM_BRIDGE__;
  if (!bridge) {
    return {
      ok: false,
      code: 'NOT_DESKTOP',
      error: '当前运行在浏览器模式，请在观澜桌面客户端中调用系统默认应用',
    };
  }
  try {
    const res = await bridge.openWithDefaultApp(relativePath);
    return {
      ok: true,
      message: res.message || '已调用系统默认应用打开',
      absolutePath: res.absolutePath ?? null,
    };
  } catch (err) {
    const parsed = parseBridgeError(err);
    return { ok: false, code: parsed.code, error: parsed.message };
  }
}

export async function copyTextWithDesktopFallback(
  text: string
): Promise<{ ok: boolean; error?: string }> {
  const bridge = globals().__GUANLAN_SYSTEM_BRIDGE__;
  if (bridge) {
    try {
      await bridge.writeClipboardText(text);
      return { ok: true };
    } catch {
      // 降级到 Web 剪贴板 API
    }
  }
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
  if (typeof document !== 'undefined') {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', 'true');
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      const copied = document.execCommand('copy');
      document.body.removeChild(ta);
      if (copied) return { ok: true };
    } catch {
      // fall through
    }
  }
  return { ok: false, error: '当前环境不可写入剪贴板' };
}

export async function resolveDesktopAbsolutePath(
  relativePath: string,
  fallbackRootPath?: string
): Promise<string | null> {
  const bridge = globals().__GUANLAN_SYSTEM_BRIDGE__;
  if (bridge) {
    try {
      return await bridge.resolveWorkspacePath(relativePath);
    } catch {
      // 如果只是路径还未落地或非法，仅回退到安全纯计算（同样校验穿越）
    }
  }
  if (!fallbackRootPath) return null;
  return resolveWorkspaceAbsolutePath(fallbackRootPath, relativePath, true);
}

export async function importDesktopExternalFiles(
  sourcePaths: string[],
  targetDir: string
): Promise<ImportExternalFilesOutcome> {
  const bridge = globals().__GUANLAN_SYSTEM_BRIDGE__;
  if (!bridge) {
    return {
      ok: false,
      code: 'NOT_DESKTOP',
      error: '外部文件拖入落盘需在观澜桌面客户端中使用',
    };
  }
  try {
    const data = await bridge.importExternalFiles(sourcePaths, targetDir);
    return { ok: true, data };
  } catch (err) {
    const parsed = parseBridgeError(err);
    return { ok: false, code: parsed.code, error: parsed.message };
  }
}

export function subscribeNativeDragDrop(
  handler: (event: NativeDragDropEvent) => void
): () => void {
  if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') {
    return () => {};
  }
  const listener = (rawEvent: Event) => {
    const detail = (rawEvent as CustomEvent<NativeDragDropEvent>).detail;
    if (!detail || typeof detail.kind !== 'string') return;
    handler(detail);
  };
  window.addEventListener('guanlan:native-drag-drop', listener);
  return () => {
    window.removeEventListener('guanlan:native-drag-drop', listener);
  };
}


/** C03：桌面壳全局热键事件（guanlan-desktop tauri-plugin-global-shortcut 原生转发；
 *  payload 携带命中的热键串，如 "alt+k"；浏览器/非桌面环境静默无订阅）。 */
export interface GlobalShortcutEvent {
  hotkey: string;
}

export function subscribeGlobalShortcut(
  handler: (event: GlobalShortcutEvent) => void
): () => void {
  if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') {
    return () => {};
  }
  const listener = (rawEvent: Event) => {
    const detail = (rawEvent as CustomEvent<GlobalShortcutEvent>).detail;
    if (!detail || typeof detail.hotkey !== 'string') return;
    handler(detail);
  };
  window.addEventListener('guanlan:global-shortcut', listener);
  return () => {
    window.removeEventListener('guanlan:global-shortcut', listener);
  };
}
