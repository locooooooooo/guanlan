
import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import type { FileFormat } from '../types/guanlan';

const DEFAULT_EXCLUDED = [
  'node_modules',
  '.git',
  '.venv',
  '_软件安装包',
  '_spike',
  'dist',
  'runtime',
  'backups',
  'tmp',
];

function looksLikePdf(filePath: string): boolean {
  if (!fs.existsSync(filePath)) return false;
  try {
    const fd = fs.openSync(filePath, 'r');
    try {
      const buf = Buffer.alloc(4);
      const read = fs.readSync(fd, buf, 0, 4, 0);
      return read === 4 && buf.toString('latin1') === '%PDF';
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
}

/**
 * 纯采集结果：只产出路径、字节哈希、mtime 和内容获取器。
 * 版本与事件由服务端比对持久库后分配。
 */
export interface CollectedFile {
  relativePath: string;
  fileName: string;
  format: FileFormat;
  sizeBytes: number;
  mtimeMs: number;
  sha256: string;
  stable: boolean;
  readContent: () => Buffer;
}

export interface CollectOptions {
  excludedDirs?: string[];
  maxFiles?: number;
  maxDepth?: number;
}

export interface CollectResult {
  files: CollectedFile[];
  readErrors: Array<{ relativePath: string; message: string }>;
  complete: boolean;
  truncated: boolean;
}

function hashFileStable(fullPath: string): {
  sha256: string;
  sizeBytes: number;
  mtimeMs: number;
  bytes: Buffer;
  stable: boolean;
} {
  const statOf = () => {
    const s = fs.statSync(fullPath);
    return { size: s.size, mtimeMs: s.mtimeMs };
  };
  const attempt = () => {
    const before = statOf();
    const bytes = fs.readFileSync(fullPath);
    const after = statOf();
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const stable = before.size === after.size && before.mtimeMs === after.mtimeMs;
    return { sha256, sizeBytes: after.size, mtimeMs: after.mtimeMs, bytes, stable };
  };

  const first = attempt();
  if (first.stable) return first;

  return attempt();
}

function formatOf(ext: string): FileFormat | null {
  const e = ext.toLowerCase();
  if (e === '.md' || e === '.markdown') return 'md';
  if (e === '.svg') return 'svg';
  if (e === '.pdf') return 'pdf';
  return null;
}

/**
 * 采集工作区文件清单（不做任何版本/事件判定）
 */
export function collectWorkspace(rootPath: string, options: CollectOptions = {}): CollectResult {
  const root = path.resolve(rootPath);
  const excluded = [...DEFAULT_EXCLUDED, ...(options.excludedDirs || [])];
  const maxFiles = options.maxFiles ?? 5000;
  const maxDepth = options.maxDepth ?? 14;

  const files: CollectedFile[] = [];
  const readErrors: Array<{ relativePath: string; message: string }> = [];
  let complete = true;
  let truncated = false;

  const isExcluded = (name: string) =>
    excluded.some((pattern) => {
      if (pattern.includes('*')) {
        const regex = new RegExp(
          '^' + pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$'
        );
        return regex.test(name);
      }
      return name === pattern;
    });

  const walk = (dir: string, relativeDir: string, depth: number) => {
    if (depth > maxDepth || files.length >= maxFiles) {
      truncated = true;
      complete = false;
      return;
    }
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      complete = false;
      readErrors.push({
        relativePath: relativeDir || '.',
        message: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    for (const entry of entries) {
      if (files.length >= maxFiles) {
        truncated = true;
        complete = false;
        return;
      }
      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        if (entry.name.startsWith('.') || isExcluded(entry.name)) continue;
        walk(fullPath, relativeDir ? `${relativeDir}/${entry.name}` : entry.name, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;

      let format = formatOf(path.extname(entry.name));
      if (!format) {
        format = looksLikePdf(fullPath) ? 'pdf' : null;
      }
      if (!format) continue;

      const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
      try {
        const { sha256, sizeBytes, mtimeMs, bytes, stable } = hashFileStable(fullPath);
        const capturedPath = fullPath;
        files.push({
          relativePath,
          fileName: entry.name,
          format,
          sizeBytes,
          mtimeMs,
          sha256,
          stable,
          readContent: () => bytes ?? fs.readFileSync(capturedPath),
        });
      } catch (error) {
        readErrors.push({
          relativePath,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  };

  if (!fs.existsSync(root)) {
    return { files: [], readErrors: [{ relativePath: '.', message: `根目录不存在: ${root}` }], complete: false, truncated: false };
  }
  walk(root, '', 0);

  return { files, readErrors, complete, truncated };
}
