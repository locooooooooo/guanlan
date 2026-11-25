/**
 * 观澜 Guanlan 工作区文件采集器（Node 对拍基线）
 *
 * 核心职责:
 * - 授权根目录枚举（仅指定目录）
 * - 递归采集 MD/SVG/PDF 文件
 * - 计算 SHA-256 字节哈希并做稳定读取校验
 * - 产出纯采集结果 CollectedFile，版本与事件由服务端比对持久库后分配
 *
 * 运行环境: Node.js（供测试与 Rust 写入对拍基准调用）
 */

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

/** 通过文件头魔数判断 PDF（无扩展名的内容也认） */
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
  /** 文件系统修改时间，仅作为独立事实保存，不当成 observed_at */
  mtimeMs: number;
  /** 稳定读取后的完整字节 SHA-256 */
  sha256: string;
  /** 读取期间未被改写；false 时本轮不落版本，只报告读取问题 */
  stable: boolean;
  /** 惰性读取原始字节：仅在需要写快照时调用，避免整批内容驻留内存 */
  readContent: () => Buffer;
}

export interface CollectOptions {
  excludedDirs?: string[];
  maxFiles?: number;
  maxDepth?: number;
}

export interface CollectResult {
  files: CollectedFile[];
  /** 采集期间读不到的路径：不登记缺失，只报告问题 */
  readErrors: Array<{ relativePath: string; message: string }>;
  /** 采集是否覆盖了指定范围的完整遍历；不完整时不得据此判定缺失 */
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
  // 稳定读取：先取 stat，读字节算哈希，再取 stat；若期间 size/mtime 变化则重读一次
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

  // 读取期间文件被改写：以第二次为准；仍不稳定则由调用方按 read_error 处理，不落版本
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
      // 范围不完整：complete 必须同步为 false，调用方才不会把截断范围外的文件误判缺失
      complete = false;
      return;
    }
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      // 目录暂时读不到：保留原有记录，报告问题，不判定缺失
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
        // 无扩展名但内容像 PDF 时仍纳入
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
          // 哈希阶段已读入的字节可复用，避免对同一文件二次全量读取
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
