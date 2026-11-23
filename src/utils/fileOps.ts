import type { FileMutationResponse } from '../services/apiTypes';
import { formatClassOf, normalizeFormatToken } from './formatMeta';
import { normalizeRelativeWorkspacePath } from './workspacePaths';

/**
 * A05 身份保真文件操作的前端纯函数校验与目录辅助模块（B01 同步放开格式族兼容重命名）。
 *
 * 与 Rust 内核 `guanlan-core/src/index/file_ops.rs` 和 `collector.rs` 保持同口径：
 * - 拒绝路径穿越（`..`）、绝对路径、盘符、UNC、NTFS 流冒号、控制符、点号隐藏名与 Windows 保留名；
 * - 拒绝移入被排除的构建/依赖目录（避免移入后从索引消失）；
 * - 重命名须保持同一格式族内的兼容扩展名（如 `.md ↔ .markdown`、`.png ↔ .jpg`）。
 */

/** 与 `guanlan-core/src/index/collector.rs::DEFAULT_EXCLUDED` 逐项对齐 */
export const DEFAULT_EXCLUDED_DIRS = new Set<string>([
  'node_modules',
  'bower_components',
  'vendor',
  'Pods',
  '.pnp',
  '.pnpm-store',
  '.yarn',
  '.git',
  '.svn',
  '.hg',
  '.idea',
  '.vscode',
  '.venv',
  'venv',
  '__pycache__',
  '.mypy_cache',
  '.pytest_cache',
  '.ruff_cache',
  '.tox',
  '.nox',
  '.gradle',
  '.m2',
  'target',
  'cmake-build-debug',
  'cmake-build-release',
  'CMakeFiles',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.turbo',
  '.parcel-cache',
  '.cache',
  '.terraform',
  'AppData',
  '$RECYCLE.BIN',
  'System Volume Information',
  'Windows',
  'Program Files',
  'Program Files (x86)',
  'ProgramData',
  '_软件安装包',
  '_spike',
  'dist',
  'runtime',
  'backups',
  'tmp',
]);

const WINDOWS_RESERVED_STEMS = new Set<string>([
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

export type SupportedFileFormat = string;

const KNOWN_EXTENSIONLESS_TOKENS: Record<string, string> = {
  makefile: 'make',
  gnumakefile: 'make',
  dockerfile: 'dockerfile',
  containerfile: 'containerfile',
  license: 'license',
  licence: 'license',
  readme: 'readme',
  changelog: 'changelog',
  authors: 'text',
  contributors: 'text',
  copying: 'license',
  notice: 'text',
  todo: 'text',
  codeowners: 'text',
  '.gitignore': 'gitignore',
  '.gitattributes': 'gitattributes',
  '.gitmodules': 'gitmodules',
  '.editorconfig': 'editorconfig',
  '.env': 'env',
};

function hasControlChar(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    if (value.charCodeAt(i) < 0x20) return true;
  }
  return false;
}

function isWindowsReservedStem(name: string): boolean {
  const stem = name.split('.')[0] ?? name;
  return WINDOWS_RESERVED_STEMS.has(stem.toUpperCase());
}

/** 归一化工作区相对路径的斜杠（仅用于拆分显示，不做越界放行） */
export function normalizeSlashes(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
}

/** 返回文件所在的父目录相对路径；工作区根目录下的文件返回 `""` */
export function parentDirOf(relativePath: string): string {
  const norm = normalizeSlashes(relativePath);
  const idx = norm.lastIndexOf('/');
  return idx < 0 ? '' : norm.slice(0, idx);
}

/** 返回路径末段文件名（含扩展名） */
export function fileNameOf(relativePath: string): string {
  const norm = normalizeSlashes(relativePath);
  const idx = norm.lastIndexOf('/');
  return idx < 0 ? norm : norm.slice(idx + 1);
}

/** 与 `collector::format_of` 保持一致的扩展名格式识别（含 `.markdown → md` 归并） */
export function formatFromFileName(name: string): SupportedFileFormat | null {
  const trimmed = name.trim();
  if (!trimmed) return null;
  const lower = trimmed.toLowerCase();
  if (lower.endsWith('.md') || lower.endsWith('.markdown')) return 'md';
  const dotIdx = lower.lastIndexOf('.');
  if (dotIdx > 0 && dotIdx < lower.length - 1) {
    return lower.slice(dotIdx + 1);
  }
  return KNOWN_EXTENSIONLESS_TOKENS[lower] ?? 'bin';
}

function validateSingleSegment(
  raw: string,
  kindLabel: string
): { ok: true; value: string } | { ok: false; error: string } {
  const trimmed = raw.trim();
  if (!trimmed || trimmed === '.' || trimmed === '..') {
    return { ok: false, error: `${kindLabel}不能为空或包含 "." / ".."` };
  }
  if (
    trimmed.includes('\0') ||
    trimmed.includes('/') ||
    trimmed.includes('\\') ||
    trimmed.includes(':') ||
    hasControlChar(trimmed)
  ) {
    return { ok: false, error: `${kindLabel}包含非法字符：${trimmed}` };
  }
  if (trimmed.startsWith('.')) {
    return { ok: false, error: `禁止使用点号开头的隐藏名称：${trimmed}` };
  }
  if (isWindowsReservedStem(trimmed)) {
    return { ok: false, error: `名称命中系统保留字：${trimmed}` };
  }
  return { ok: true, value: trimmed };
}

function validateFormatCompatibleName(
  rawName: string,
  currentFormat: SupportedFileFormat
): { ok: true; value: string } | { ok: false; error: string } {
  const seg = validateSingleSegment(rawName, '文件名');
  if (!seg.ok) return seg;
  const detected = formatFromFileName(seg.value);
  const expectedClass = formatClassOf(normalizeFormatToken(currentFormat));
  if (!detected || formatClassOf(detected) !== expectedClass) {
    return {
      ok: false,
      error: `重命名须保持兼容的格式扩展名（当前为 ${currentFormat.toUpperCase()}，不允许改为「${seg.value}」）`,
    };
  }
  return seg;
}

export type RenameValidationResult =
  | { ok: true; normalizedName: string; targetRelativePath: string }
  | { ok: false; error: string };

/** 校验同目录重命名输入 */
export function validateRenameInput(
  rawName: string,
  currentPath: string,
  currentFormat: SupportedFileFormat
): RenameValidationResult {
  const checked = validateFormatCompatibleName(rawName, currentFormat);
  if (!checked.ok) return checked;

  const currentBase = fileNameOf(currentPath);
  if (checked.value === currentBase) {
    return { ok: false, error: '新文件名与当前文件名相同，请输入新名称' };
  }
  const parent = parentDirOf(currentPath);
  const targetRelativePath = parent ? `${parent}/${checked.value}` : checked.value;
  return {
    ok: true,
    normalizedName: checked.value,
    targetRelativePath,
  };
}

export type MoveValidationResult =
  | { ok: true; targetDir: string; fileName: string; targetRelativePath: string }
  | { ok: false; error: string };

/** 校验跨目录移动输入（允许可选同步改名） */
export function validateMoveInput(
  rawTargetDir: string,
  currentPath: string,
  currentFormat: SupportedFileFormat,
  rawNewName?: string
): MoveValidationResult {
  if (typeof rawTargetDir !== 'string' || rawTargetDir.includes('\0')) {
    return { ok: false, error: '目标目录包含非法空字节' };
  }
  const trimmedDir = rawTargetDir.trim();
  let targetDir = '';
  if (trimmedDir !== '' && trimmedDir !== '.') {
    const normalizedDir = normalizeRelativeWorkspacePath(trimmedDir, false);
    if (normalizedDir === null) {
      return {
        ok: false,
        error: '目标目录非法：拒绝绝对路径、盘符、冒号、".." 越界或系统保留字',
      };
    }
    const segs = normalizedDir.split('/');
    for (const seg of segs) {
      const checkedSeg = validateSingleSegment(seg, '目录段');
      if (!checkedSeg.ok) return checkedSeg;
      if (DEFAULT_EXCLUDED_DIRS.has(checkedSeg.value)) {
        return {
          ok: false,
          error: `目标目录包含被排除的依赖/构建目录（${checkedSeg.value}），移入会导致索引丢失`,
        };
      }
    }
    targetDir = segs.join('/');
  }

  const currentBase = fileNameOf(currentPath);
  let fileName = currentBase;
  if (rawNewName !== undefined && rawNewName.trim().length > 0) {
    const checkedName = validateFormatCompatibleName(rawNewName, currentFormat);
    if (!checkedName.ok) return checkedName;
    fileName = checkedName.value;
  }

  const targetRelativePath = targetDir ? `${targetDir}/${fileName}` : fileName;
  if (targetRelativePath === normalizeSlashes(currentPath)) {
    return { ok: false, error: '目标路径与当前路径一致，请选择其他目录或修改文件名' };
  }
  return { ok: true, targetDir, fileName, targetRelativePath };
}

/**
 * 从当前工作区文件列表提取可供「移动到目录」快速选择的目录清单。
 * 总是包含 `""`（工作区根目录）以及所有已存在子目录及其祖先目录，去重后按字典序稳定排列。
 */
export function collectWorkspaceFolderOptions(
  files: ReadonlyArray<{ relative_path: string }>
): string[] {
  const dirs = new Set<string>(['']);
  for (const file of files) {
    const dir = parentDirOf(file.relative_path);
    if (!dir) continue;
    const parts = dir.split('/');
    let acc = '';
    for (const part of parts) {
      if (!part) continue;
      acc = acc ? `${acc}/${part}` : part;
      dirs.add(acc);
    }
  }
  return Array.from(dirs).sort((a, b) => {
    if (a === '') return -1;
    if (b === '') return 1;
    return a.localeCompare(b, 'zh-Hans-CN');
  });
}

/** 构造 A05 操作成功后的用户可读反馈文案 */
export function describeFileMutationSuccess(resp: FileMutationResponse): string {
  switch (resp.operation) {
    case 'file_renamed':
      return `已安全重命名为 ${resp.new_path ?? resp.old_path}（file_id、历史版本与关联决定保持 100% 连续）`;
    case 'file_moved':
      return `已安全移动到 ${resp.new_path ?? resp.old_path}（file_id、路径别名与关联决定保持 100% 连续）`;
    case 'file_trashed':
      return `已移入系统回收站（非永久删除）：${resp.old_path}。从系统回收站还原并刷新后，原历史与阅读进度将自动重连。`;
  }
}
