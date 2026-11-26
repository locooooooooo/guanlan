
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';

export interface WatchChange {
  at: string;
  scanned: number;
  newEvents: number;
  newRevisions: number;
  generation: number;
  paths: string[];
}

export interface WorkspaceWatcherOptions {
  rootPath: string;
  debounceMs?: number;
  minIntervalMs?: number;
  reconcile: () => {
    scanned: number;
    newEvents: number;
    newRevisions: number;
    generation: number;
  };
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
      this.watcher = fs.watch(root, { recursive: true }, (eventType, filename) => {
        if (!filename) return;
        const rel = String(filename).replace(/\\/g, '/');
        if (this.isIgnored(rel)) return;
        this.pendingPaths.add(rel);
        this.schedule();
      });
      this.watcher.on('error', () => {
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
      this.timer = setTimeout(() => void this.flush(), minInterval - sinceLast);
      return;
    }
    if (this.running) {
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
      }
    }
    this.clients.clear();
  }
}
