/**
 * 工作区相对/绝对路径解析与路径穿越防线（A04）。
 *
 * 与 Rust 端 `guanlan-desktop/src/system_bridge.rs` 保持同口径：
 * - 拒绝绝对路径、盘符、UNC、NTFS 流冒号、`..` 上跳、空字节与系统保留名；
 * - 前端展示与剪贴板统一共享此单一出口，不各处拼接路径。
 */

const WINDOWS_RESERVED_STEMS = new Set([
  'CON',
  'PRN',
  'AUX',
  'NUL',
  'COM1',
  'COM2',
  'COM3',
  'COM4',
  'COM5',
  'COM6',
  'COM7',
  'COM8',
  'COM9',
  'LPT1',
  'LPT2',
  'LPT3',
  'LPT4',
  'LPT5',
  'LPT6',
  'LPT7',
  'LPT8',
  'LPT9',
]);

function hasControlChar(s: string): boolean {
  for (let i = 0; i < s.length; i += 1) {
    if (s.charCodeAt(i) < 0x20) return true;
  }
  return false;
}

function isValidSegment(seg: string): boolean {
  if (!seg || seg === '.' || seg === '..') return false;
  if (seg.includes(':') || seg.includes('\0') || seg.includes('/') || seg.includes('\\')) {
    return false;
  }
  if (hasControlChar(seg)) return false;
  const stem = seg.split('.')[0] ?? seg;
  if (WINDOWS_RESERVED_STEMS.has(stem.toUpperCase())) return false;
  return true;
}

/**
 * 规范化工作区相对路径；发现穿越/绝对路径/保留名等非法形态返回 null。
 */
export function normalizeRelativeWorkspacePath(
  raw: string,
  allowRoot = false
): string | null {
  if (typeof raw !== 'string' || raw.includes('\0')) return null;
  const trimmed = raw.trim();
  if (trimmed === '' || trimmed === '.') {
    return allowRoot ? '' : null;
  }
  const slashNormalized = trimmed.replace(/\\/g, '/');
  if (slashNormalized.startsWith('/') || slashNormalized.includes(':')) {
    return null;
  }
  const parts = slashNormalized.split('/');
  for (const part of parts) {
    if (!isValidSegment(part)) return null;
  }
  return parts.join('/');
}

/**
 * 将工作区根路径与相对路径拼接为本机风格的绝对路径（用于复制绝对路径与提示）。
 * 若 `rootPath` 为空或 `relativePath` 越界则返回 null。
 */
export function resolveWorkspaceAbsolutePath(
  rootPath: string,
  relativePath: string,
  allowRoot = false
): string | null {
  const cleanRoot = typeof rootPath === 'string' ? rootPath.trim() : '';
  if (!cleanRoot) return null;
  const rel = normalizeRelativeWorkspacePath(relativePath, allowRoot);
  if (rel === null) return null;

  const isWinStyle =
    /^[A-Za-z]:/.test(cleanRoot) || cleanRoot.startsWith('\\\\') || cleanRoot.includes('\\');
  const sep = isWinStyle ? '\\' : '/';

  let base = cleanRoot;
  if (isWinStyle) {
    base = base.replace(/\//g, '\\');
    // 保留盘符根如 `C:\`，其余去掉尾部分隔符
    if (!/^[A-Za-z]:\\$/.test(base)) {
      base = base.replace(/\\+$/, '');
    }
  } else {
    if (base !== '/') {
      base = base.replace(/\/+$/, '');
    }
  }

  if (rel === '') return base;
  const relJoined = rel.split('/').join(sep);
  if (base.endsWith(sep)) return `${base}${relJoined}`;
  return `${base}${sep}${relJoined}`;
}

export function validateImportTargetDir(
  raw: string
): { ok: true; normalized: string } | { ok: false; error: string } {
  const rel = normalizeRelativeWorkspacePath(raw, true);
  if (rel === null) {
    return { ok: false, error: '目标目录非法或包含越界路径段（已拦截）' };
  }
  if (rel !== '') {
    const segs = rel.split('/');
    for (const seg of segs) {
      if (seg.startsWith('.')) {
        return { ok: false, error: `禁止导入到点号开头的隐藏目录：${seg}` };
      }
    }
  }
  return { ok: true, normalized: rel };
}

export function displayFolderLabel(targetDir: string): string {
  return targetDir === '' ? '工作区根目录' : targetDir;
}
