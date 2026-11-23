/**
 * 观澜 v0.4 第二轮 —— 文件监听与增量对账
 *
 * 方案 §4：文件监听负责触发复核；启动对账、手动重扫和周期性核验负责恢复遗漏。
 * Node 的 fs.watch 在不同平台有差异（Windows 目录移动有限制），
 * 因此监听只作为「触发核验」的信号，不作为审计日志；真正的版本判定仍由 reconcile 做。
 */

import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';

export interface WatchChange {
  at: string;
  scanned: number;
  newEvents: number;
  newRevisions: number;
  generation: number;
  /** 触发核验的路径（仅用于提示，不作为事实） */
  paths: string[];
}

export interface WorkspaceWatcherOptions {
  rootPath: string;
  /** 目录级防抖：写文件常触发多次事件 */
  debounceMs?: number;
  /** 两次监听核验之间的最小间隔（保护大工作区不被扫描风暴拖垮） */
  minIntervalMs?: number;
  /** 核验函数：必须返回本次对账摘要 */
  reconcile: () => {
    scanned: number;
    newEvents: number;
    newRevisions: number;
    generation: number;
  };
  /** 忽略的目录名 */
  ignoredDirs?: string[];
}

export class WorkspaceWatcher extends EventEmitter {
  private watcher: fs.FSWatcher | null = null;
  private timer: NodeJS.Timeout | null = null;
  private pendingPaths = new Set<string>();
  private running = false;
  private queued = false;
  private lastRunAt = 0;

  constructor(private options: WorkspaceWatcherOptions) {
    super();
  }

  start(): boolean {
    const root = path.resolve(this.options.rootPath);
    if (!fs.existsSync(root)) return false;
    try {
      // recursive 在 Windows 与 macOS 可用；Linux 上抛错则退化为不监听
      this.watcher = fs.watch(root, { recursive: true }, (eventType, filename) => {
        if (!filename) return;
        const rel = String(filename).replace(/\\/g, '/');
        if (this.isIgnored(rel)) return;
        this.pendingPaths.add(rel);
        this.schedule();
      });
      this.watcher.on('error', () => {
        // 监听失败不影响对账：定时/手动重扫仍可恢复遗漏
        this.emit('watch-error', new Error('fs.watch 监听不可用'));
      });
      return true;
    } catch {
      return false;
    }
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.watcher?.close();
    this.watcher = null;
  }

  private isIgnored(rel: string): boolean {
    const ignored = this.options.ignoredDirs ?? ['node_modules', '.git', '.venv', 'dist', 'runtime', 'backups', 'tmp'];
    return rel.split('/').some((seg) => ignored.includes(seg) || seg.startsWith('.'));
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush(), this.options.debounceMs ?? 1500);
  }

  private async flush(): Promise<void> {
    this.timer = null;
    const minInterval = this.options.minIntervalMs ?? 8000;
    const sinceLast = Date.now() - this.lastRunAt;
    if (sinceLast < minInterval) {
      // 距上次核验太近：合并为一次延后核验
      this.timer = setTimeout(() => void this.flush(), minInterval - sinceLast);
      return;
    }
    if (this.running) {
      // 上一轮核验未完成：排队一次，不并发跑对账
      this.queued = true;
      return;
    }
    this.running = true;
    this.lastRunAt = Date.now();
    const paths = Array.from(this.pendingPaths);
    this.pendingPaths.clear();
    try {
      const report = this.options.reconcile();
      this.emit('change', {
        at: new Date().toISOString(),
        scanned: report.scanned,
        newEvents: report.newEvents,
        newRevisions: report.newRevisions,
        generation: report.generation,
        paths,
      } satisfies WatchChange);
    } catch (error) {
      this.emit('reconcile-error', error);
    } finally {
      this.running = false;
      if (this.queued) {
        this.queued = false;
        this.schedule();
      }
    }
  }
}

/** SSE 连接注册表：新连接补发最新 generation，断线重连不丢通知 */
export class ChangeBroadcaster {
  private clients = new Set<{
    write: (chunk: string) => void;
    end: () => void;
  }>();

  add(client: { write: (chunk: string) => void; end: () => void }): () => void {
    this.clients.add(client);
    return () => this.clients.delete(client);
  }

  broadcast(payload: unknown): number {
    const line = `data: ${JSON.stringify(payload)}\n\n`;
    let sent = 0;
    for (const client of this.clients) {
      try {
        client.write(line);
        sent++;
      } catch {
        this.clients.delete(client);
      }
    }
    return sent;
  }

  get size(): number {
    return this.clients.size;
  }

  closeAll(): void {
    for (const client of this.clients) {
      try {
        client.end();
      } catch {
        /* 已断开 */
      }
    }
    this.clients.clear();
  }
}
