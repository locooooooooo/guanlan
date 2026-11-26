
import type { Plugin } from 'vite';
import type { IncomingMessage, ServerResponse } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

import { reconcileWorkspace, type ReconcileReport } from './reconcile';
import { projectWorkspace, projectFileHistory, readRevisionContent } from './project';
import { queryEvents, queryEventDays, eventTimeRange } from './queries';
import { WorkspaceStore, defaultDataDir } from './WorkspaceStore';
import { ChangeBroadcaster, WorkspaceWatcher } from './watcher';

export interface WorkspacePluginOptions {
  rootPath: string;
  dataDir?: string;
  scanCacheTtlMs?: number;
  watchDebounceMs?: number;
}

interface ScanCache {
  payload: unknown;
  scannedAt: number;
  report: ReconcileReport;
}

interface PreparedScanBody {
  raw: Buffer;
  gzip: Promise<Buffer> | null;
}

const gzipAsync = (raw: Buffer): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    zlib.gzip(raw, { level: 6 }, (error, buf) => (error ? reject(error) : resolve(buf)));
  });

export function guanlanWorkspacePlugin(options: WorkspacePluginOptions): Plugin {
  const dataDir = options.dataDir || defaultDataDir(options.rootPath);
  const cacheTtl = options.scanCacheTtlMs ?? 60_000;

  let store: WorkspaceStore | null = null;
  let workspaceId: string | null = null;
  let cache: ScanCache | null = null;
  let revalidating = false;
  let warnLog: (message: string) => void = () => {};
  const broadcaster = new ChangeBroadcaster();
  let watcher: WorkspaceWatcher | null = null;

  const getStore = (): WorkspaceStore => {
    if (!store) {
      store = new WorkspaceStore(dataDir);
      workspaceId = store.ensureWorkspace(options.rootPath).workspace_id;
    }
    return store;
  };

  const scanBodyByPayload = new WeakMap<object, PreparedScanBody>();

  const prepareScanBody = (payload: object): void => {
    if (scanBodyByPayload.has(payload)) return;
    const raw = Buffer.from(JSON.stringify(payload), 'utf-8');
    const prepared: PreparedScanBody = { raw, gzip: null };
    scanBodyByPayload.set(payload, prepared);
    const pending = gzipAsync(raw);
    pending.catch(() => {});
    prepared.gzip = pending;
  };

  const sendJson = (res: ServerResponse, status: number, payload: unknown): void => {
    const prepared = scanBodyByPayload.get(payload as object);
    const raw = prepared ? prepared.raw : Buffer.from(JSON.stringify(payload), 'utf-8');
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Vary', 'Accept-Encoding');
    const accept = String(res.req?.headers['accept-encoding'] ?? '').toLowerCase();
    const acceptsGzip = accept
      .split(',')
      .some((part) => part.trim().split(';')[0]?.trim() === 'gzip' && !/q=0(?:\.0+)?$/.test(part));
    if (raw.length > 1024 && acceptsGzip) {
      if (prepared?.gzip) {
        const writeGzip = (body: Buffer): void => {
          if (res.writableEnded || res.destroyed) return;
          res.setHeader('Content-Encoding', 'gzip');
          res.setHeader('Content-Length', String(body.length));
          res.end(body);
        };
        const fallbackSync = (): void => {
          writeGzip(zlib.gzipSync(raw, { level: 6 }));
        };
        void prepared.gzip.then(writeGzip, fallbackSync);
        return;
      }
      const body = zlib.gzipSync(raw, { level: 6 });
      res.setHeader('Content-Encoding', 'gzip');
      res.setHeader('Content-Length', String(body.length));
      res.end(body);
      return;
    }
    res.end(raw);
  };

  const sendError = (res: ServerResponse, error: unknown): void => {
    const code = (error as { code?: string })?.code;
    const detail = (error as { detail?: string })?.detail;
    const message = error instanceof Error ? error.message : String(error);
    const status = code === 'NOT_FOUND' ? 404 : code === 'INDEX_STALE' ? 409 : 500;
    sendJson(res, status, { ok: false, code: code || 'INTERNAL', error: detail || message });
  };

  const buildCache = (): ScanCache => {
    const s = getStore();
    const { report } = reconcileWorkspace(options.rootPath, { dataDir, store: s });
    const state = projectWorkspace(s, options.rootPath);
    const payload = { ...state, reconcile: report };
    cache = {
      payload,
      scannedAt: Date.now(),
      report,
    };
    prepareScanBody(payload);
    return cache;
  };

  const scheduleRevalidate = (): void => {
    if (revalidating) return;
    revalidating = true;
    setTimeout(() => {
      try {
        const rebuilt = buildCache();
        broadcaster.broadcast({
          type: 'workspace-change',
          at: new Date().toISOString(),
          scanned: rebuilt.report.scanned,
          newEvents: rebuilt.report.eventsInserted,
          newRevisions: rebuilt.report.newRevisions,
          generation: rebuilt.report.generation,
          paths: [],
        });
      } catch (error) {
        warnLog(`[guanlan] 后台重建投影失败：${error instanceof Error ? error.message : String(error)}`);
      } finally {
        revalidating = false;
      }
    }, 0);
  };

  const doScan = (force: boolean) => {
    if (force || !cache) {
      return buildCache();
    }
    if (Date.now() - cache.scannedAt < cacheTtl) {
      return cache;
    }
    scheduleRevalidate();
    return cache;
  };

  const ensureWatcher = (): void => {
    if (watcher) return;
    watcher = new WorkspaceWatcher({
      rootPath: options.rootPath,
      debounceMs: options.watchDebounceMs ?? 1500,
      reconcile: () => {
        const s = getStore();
        const { report } = reconcileWorkspace(options.rootPath, { dataDir, store: s });
        cache = null;
        return {
          scanned: report.scanned,
          newEvents: report.eventsInserted,
          newRevisions: report.newRevisions,
          generation: report.generation,
        };
      },
    });
    watcher.on('change', (change) => {
      broadcaster.broadcast({ type: 'workspace-change', ...change });
    });
    watcher.start();
  };

  return {
    name: 'guanlan-workspace-api',
    apply: 'serve',
    configureServer(server) {
      warnLog = (message) => server.config.logger.warn(message);
      server.httpServer?.on('close', () => {
        watcher?.stop();
        broadcaster.closeAll();
      });
      setTimeout(() => {
        try {
          doScan(false);
          ensureWatcher();
        } catch (error) {
          server.config.logger.warn(
            `[guanlan] 预热对账失败：${error instanceof Error ? error.message : String(error)}`
          );
        }
      }, 200);

      server.middlewares.use(
        async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
          const rawUrl = req.url || '';
          if (!rawUrl.startsWith('/api/workspace')) {
            next();
            return;
          }
          const url = new URL(rawUrl, 'http://127.0.0.1');

          try {
            if (url.pathname === '/api/workspace/scan') {
              const force = url.searchParams.get('force') === '1';
              const result = doScan(force);
              sendJson(res, 200, result.payload);
              return;
            }

            if (url.pathname === '/api/workspace/events/days') {
              getStore();
              const kinds = (url.searchParams.get('kinds') || '')
                .split(',')
                .map((s) => s.trim())
                .filter(Boolean);
              const format = url.searchParams.get('format');
              const granularity = url.searchParams.get('granularity');
              const order = url.searchParams.get('order');
              const days = queryEventDays(getStore(), {
                workspaceId: workspaceId!,
                from: url.searchParams.get('from') || undefined,
                to: url.searchParams.get('to') || undefined,
                kinds: kinds.length ? kinds : undefined,
                format: format === 'md' || format === 'svg' || format === 'pdf' ? format : undefined,
                order: order === 'observed' ? 'observed' : 'occurred',
                granularity:
                  granularity === 'week' || granularity === 'month' ? granularity : undefined,
                limitDays: Number(url.searchParams.get('limitDays') || 30),
                samplesPerDay: Number(url.searchParams.get('samples') || 4),
              });
              sendJson(res, 200, days);
              return;
            }

            if (url.pathname === '/api/workspace/events') {
              getStore();
              const kinds = (url.searchParams.get('kinds') || url.searchParams.get('kind') || '')
                .split(',')
                .map((s) => s.trim())
                .filter(Boolean);
              const format = url.searchParams.get('format');
              const order = url.searchParams.get('order');
              const page = queryEvents(getStore(), {
                workspaceId: workspaceId!,
                from: url.searchParams.get('from') || undefined,
                to: url.searchParams.get('to') || undefined,
                kinds: kinds.length ? kinds : undefined,
                format:
                  format === 'md' || format === 'svg' || format === 'pdf' ? format : undefined,
                order: order === 'observed' ? 'observed' : 'occurred',
                undated: url.searchParams.get('undated') === '1',
                q: url.searchParams.get('q') || undefined,
                limit: Number(url.searchParams.get('limit') || 50),
                cursor: url.searchParams.get('cursor') || null,
              });
              sendJson(res, 200, page);
              return;
            }

            if (url.pathname === '/api/workspace/events/range') {
              getStore();
              sendJson(res, 200, { ok: true, ...eventTimeRange(getStore(), workspaceId!) });
              return;
            }

            if (url.pathname === '/api/workspace/history') {
              getStore();
              const fileId = url.searchParams.get('file_id') || '';
              const history = projectFileHistory(getStore(), fileId);
              if (!history) {
                sendJson(res, 404, { ok: false, code: 'NOT_FOUND', error: `未找到文件 ${fileId}` });
                return;
              }
              sendJson(res, 200, { ok: true, ...history });
              return;
            }

            const revMatch = /^\/api\/workspace\/revisions\/([^/]+)\/content$/.exec(url.pathname);
            if (revMatch) {
              getStore();
              const revisionId = decodeURIComponent(revMatch[1]);
              const content = readRevisionContent(getStore(), revisionId);
              if (!content.ok) {
                sendJson(res, content.error === 'NOT_FOUND' ? 404 : 410, {
                  ok: false,
                  code: content.error,
                  error:
                    content.error === 'REVISION_UNAVAILABLE'
                      ? '此版本正文已过保留期，仅保留版本元数据；可打开当前版本或查看其他仍可用的版本。'
                      : '未找到该版本',
                });
                return;
              }
              if (content.format === 'pdf' && content.snapshotPath) {
                if (url.searchParams.get('raw') === '1') {
                  res.statusCode = 200;
                  res.setHeader('Content-Type', 'application/pdf');
                  fs.createReadStream(content.snapshotPath).pipe(res);
                  return;
                }
                sendJson(res, 200, {
                  ok: true,
                  format: 'pdf',
                  revision_id: revisionId,
                  raw_url: `/api/workspace/revisions/${encodeURIComponent(revisionId)}/content?raw=1`,
                });
                return;
              }
              sendJson(res, 200, {
                ok: true,
                format: content.format,
                revision_id: revisionId,
                text: content.text,
              });
              return;
            }

            if (url.pathname === '/api/workspace/summary') {
              const s = getStore();
              const ws = s.getWorkspace(workspaceId!);
              sendJson(res, 200, {
                ok: true,
                workspace_id: workspaceId,
                root_path: ws?.root_path,
                data_dir: dataDir,
                index_generation: ws?.index_generation ?? 0,
                last_scan_at: ws?.last_scan_at ?? null,
                baseline: s.hasBaseline(workspaceId!),
                counts: s.counts(workspaceId!),
                time_range: eventTimeRange(s, workspaceId!),
              });
              return;
            }

            if (url.pathname === '/api/workspace/file') {
              const rel = url.searchParams.get('path') || '';
              const boundary = validatePath(options.rootPath, rel);
              if (!boundary.allowed) {
                sendJson(res, 403, { ok: false, code: 'OUT_OF_SCOPE', error: boundary.reason });
                return;
              }
              const fullPath = path.resolve(options.rootPath, rel);
              if (!fs.existsSync(fullPath)) {
                sendJson(res, 404, { ok: false, code: 'NOT_FOUND', error: '文件不存在' });
                return;
              }
              const ext = path.extname(fullPath).toLowerCase();
              const stat = fs.statSync(fullPath);

              if (ext === '.svg') {
                res.statusCode = 200;
                res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8');
                res.end(fs.readFileSync(fullPath));
                return;
              }
              if (ext === '.pdf') {
                res.statusCode = 200;
                res.setHeader('Content-Type', 'application/pdf');
                res.setHeader('Content-Length', String(stat.size));
                fs.createReadStream(fullPath).pipe(res);
                return;
              }
              sendJson(res, 200, {
                ok: true,
                path: rel,
                text: fs.readFileSync(fullPath, 'utf-8'),
                sizeBytes: stat.size,
              });
              return;
            }

            if (url.pathname === '/api/workspace/stream') {
              getStore();
              ensureWatcher();
              res.statusCode = 200;
              res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
              res.setHeader('Cache-Control', 'no-cache, no-transform');
              res.setHeader('Connection', 'keep-alive');
              res.write(
                `data: ${JSON.stringify({
                  type: 'hello',
                  generation: getStore().getWorkspace(workspaceId!)?.index_generation ?? 0,
                  watching: Boolean(watcher),
                })}\n\n`
              );
              const heartbeat = setInterval(() => {
                try {
                  res.write(': ping\n\n');
                } catch {
                }
              }, 25_000);
              const remove = broadcaster.add({
                write: (chunk) => res.write(chunk),
                end: () => res.end(),
              });
              req.on('close', () => {
                clearInterval(heartbeat);
                remove();
              });
              return;
            }

            if (url.pathname === '/api/workspace/config') {
              sendJson(res, 200, {
                rootPath: options.rootPath,
                dataDir,
                exists: fs.existsSync(options.rootPath),
              });
              return;
            }

            next();
          } catch (error) {
            sendError(res, error);
          }
        }
      );
    },
  };
}

/**
 * 路径边界校验：拒绝越界访问（..、盘符越界、UNC）
 */
export function validatePath(
  rootPath: string,
  requested: string
): { allowed: boolean; reason: string } {
  if (!requested) return { allowed: false, reason: '空路径' };
  const normalized = requested.replace(/\\/g, '/');

  if (normalized.startsWith('//') || normalized.startsWith('\\\\')) {
    return { allowed: false, reason: '拒绝 UNC 网络路径' };
  }
  if (normalized.split('/').includes('..')) {
    return { allowed: false, reason: '检测到路径穿越 (..)' };
  }
  if (/^[a-zA-Z]:\//.test(normalized)) {
    const normRoot = path.resolve(rootPath).replace(/\\/g, '/').toLowerCase();
    if (!normalized.toLowerCase().startsWith(normRoot + '/')) {
      return { allowed: false, reason: '绝对路径不在已配置根目录范围内' };
    }
  }

  const resolved = path.resolve(rootPath, requested);
  const normRoot = path.resolve(rootPath);
  if (!resolved.toLowerCase().startsWith(normRoot.toLowerCase())) {
    return { allowed: false, reason: '解析后路径越界' };
  }
  return { allowed: true, reason: '' };
}

export default guanlanWorkspacePlugin;
