/**
 * 观澜 Node 对拍基线 —— Vite 开发服务器中间件（已冻结，仅作测试与历史参考）
 *
 * 职责：
 * - 扫描器只产出路径、字节哈希、mtime 和内容；本服务比对持久库后分配版本与事件
 * - 查询接口支持分页：/api/workspace/events 支持日期、事项、格式、种类、时间口径和游标
 * - 按文件/版本 ID 读取内容，不提供任意路径下载（/api/workspace/file 仅限已配置根目录）
 */

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
  /** 持久库目录；默认 %LOCALAPPDATA%/Guanlan/workspaces/<rootKey> */
  dataDir?: string;
  /** 开发期扫描缓存，避免 StrictMode 双挂载重复对账 */
  scanCacheTtlMs?: number;
  /** 文件监听防抖（毫秒） */
  watchDebounceMs?: number;
}

interface ScanCache {
  payload: unknown;
  scannedAt: number;
  report: ReconcileReport;
}

/**
 * /scan 载荷的按代预计算体：JSON 序列化字节 + gzip 字节。
 * 载荷可达数十 MiB：此前每请求重复 stringify 并在事件循环上同步 gzipSync
 * （53MB 载荷实测阻塞 ~24s，期间所有 API/静态请求排队）。
 */
interface PreparedScanBody {
  /** 本代 payload 的 JSON 字节（payload 每代新建且不再变更，字节与逐次 stringify 恒等） */
  raw: Buffer;
  /** null = 尚未就绪；就绪后为 raw 的 gzip(level 6) 字节 */
  gzip: Promise<Buffer> | null;
}

/** gzip 走 zlib 异步 API（线程池），压缩期间事件循环保持响应 */
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

  // /scan 预计算缓存：以 payload 对象身份为键（WeakMap）。stale-while-revalidate
  // 每代重建全新 payload，旧代条目随之失效，绝不跨代复用（重建会更新 scannedAt 等
  // 字段，字节必然变化）。
  const scanBodyByPayload = new WeakMap<object, PreparedScanBody>();

  // 代内预计算：序列化一次，gzip 在线程池后台完成；完成后 sendJson 对同代请求直发字节
  const prepareScanBody = (payload: object): void => {
    if (scanBodyByPayload.has(payload)) return;
    const raw = Buffer.from(JSON.stringify(payload), 'utf-8');
    const prepared: PreparedScanBody = { raw, gzip: null };
    scanBodyByPayload.set(payload, prepared);
    const pending = gzipAsync(raw);
    // 无人消费（如本代刚建好就被更新代替换）也不产生 unhandledRejection；消费方自行兜底
    pending.catch(() => {});
    prepared.gzip = pending;
  };

  const sendJson = (res: ServerResponse, status: number, payload: unknown): void => {
    // /scan 命中本代预计算时复用序列化字节；其余载荷逐次 stringify（原路径）
    const prepared = scanBodyByPayload.get(payload as object);
    const raw = prepared ? prepared.raw : Buffer.from(JSON.stringify(payload), 'utf-8');
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Vary', 'Accept-Encoding');
    // scan/events 的 JSON 可达 9 MiB 级：客户端声明支持 gzip 时压缩传输
    // （fetch 会透明解压，响应结构与契约不变），可减约 80% 传输量
    const accept = String(res.req?.headers['accept-encoding'] ?? '').toLowerCase();
    const acceptsGzip = accept
      .split(',')
      .some((part) => part.trim().split(';')[0]?.trim() === 'gzip' && !/q=0(?:\.0+)?$/.test(part));
    if (raw.length > 1024 && acceptsGzip) {
      if (prepared?.gzip) {
        // 命中预计算：就绪即直发字节；在途则等线程池完成（请求稍候、事件循环零阻塞）；
        // 仅预计算失败时退回原同步路径。客户端中途断开则放弃回写。
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
    // 本代 JSON 字节与 gzip 随构建预计算（gzip 在线程池后台完成）
    prepareScanBody(payload);
    return cache;
  };

  // 缓存过期后的后台重建（stale-while-revalidate）：单飞，避免并发请求重复对账
  const scheduleRevalidate = (): void => {
    if (revalidating) return;
    revalidating = true;
    // 下一拍再跑：让当前请求先把 stale payload 发回浏览器，不再同步阻塞数十秒
    setTimeout(() => {
      try {
        const rebuilt = buildCache();
        // 重建出有新变化的数据时通知已打开的界面（复用 watcher 的通知契约）
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
    // 手动强制刷新，或还没有任何缓存可回退：同步对账（force 契约是反映当下状态）
    if (force || !cache) {
      return buildCache();
    }
    if (Date.now() - cache.scannedAt < cacheTtl) {
      return cache;
    }
    // 缓存过期：立即返回上一次 payload，由后台重建替换，
    // 避免每过 TTL 的首个请求同步阻塞数十秒
    scheduleRevalidate();
    return cache;
  };

  // 监听只触发核验；防抖后跑一次对账，有新变化就通过 SSE 通知界面
  const ensureWatcher = (): void => {
    if (watcher) return;
    watcher = new WorkspaceWatcher({
      rootPath: options.rootPath,
      debounceMs: options.watchDebounceMs ?? 1500,
      reconcile: () => {
        const s = getStore();
        const { report } = reconcileWorkspace(options.rootPath, { dataDir, store: s });
        cache = null; // 下次读取时重新投影
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
      // 启动预热：后台对账一次，浏览器首屏直接命中缓存
      setTimeout(() => {
        try {
          doScan(false);
          // 首次扫描后启动监听（核验驱动，非逐条事件日志）
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
            // ---------- 扫描并入账：GET /api/workspace/scan?force=1 ----------
            if (url.pathname === '/api/workspace/scan') {
              const force = url.searchParams.get('force') === '1';
              const result = doScan(force);
              sendJson(res, 200, result.payload);
              return;
            }

            // ---------- 按日/周/月聚合（画布标尺与折叠组）：GET /api/workspace/events/days ----------
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

            // ---------- 分页事件：GET /api/workspace/events ----------
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

            // ---------- 实际时间范围：GET /api/workspace/events/range ----------
            if (url.pathname === '/api/workspace/events/range') {
              getStore();
              sendJson(res, 200, { ok: true, ...eventTimeRange(getStore(), workspaceId!) });
              return;
            }

            // ---------- 单文件版本链：GET /api/workspace/history?file_id= ----------
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

            // ---------- 按版本取内容：GET /api/workspace/revisions/<id>/content ----------
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

            // ---------- 摘要：GET /api/workspace/summary ----------
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

            // ---------- 单文件内容（现有阅读器直读）：GET /api/workspace/file?path= ----------
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

            // ---------- 增量通知（SSE）：GET /api/workspace/stream ----------
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
                  /* 断开后由 close 清理 */
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

            // ---------- 配置：GET /api/workspace/config ----------
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
