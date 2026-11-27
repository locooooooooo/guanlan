
import type {
  BootstrapResponse,
  CasConflictDetail,
  CheckpointCommitRequest,
  CheckpointCommitResult,
  CheckpointRecord,
  CheckpointsPage,
  ContextRequest,
  ContextResponse,
  DecisionResolveAccepted,
  DecisionResolveRequest,
  DiffJobRequest,
  DiffResult,
  DecisionsResponse,
  FileSummaryDetailResponse,
  FileMutationResponse,
  IndexJobAccepted,
  IndexJobStatus,
  InitiativeJobAccepted,
  InitiativeTasksResponse,
  JobAccepted,
  JobCancelResult,
  JobReportAdopt,
  JobReportDismiss,
  JobReportOrphanRepair,
  JobReportWriteback,
  JobResultResponse,
  L4aProgress,
  McpHostConfigRequest,
  McpHostConfigResponse,
  MoveFileRequest,
  OrphanRepairRequest,
  ReviewBoardResponse,
  EventDayGroup,
  EventDayItem,
  EventDaysResult,
  EventPage,
  EventPageItem,
  EventTimeRange,
  FileFacets,
  FileRevisionsResponse,
  FileSummary,
  FileSummaryPage,
  ImagePreviewMeta,
  RelationsResponse,
  RenameFileRequest,
  RevisionContentResponse,
  RevisionPreviewHistoryItem,
  RevisionPreviewKind,
  RevisionPreviewResponse,
  RevisionProposalAccepted,
  RevisionProposalContentResponse,
  RevisionProposalPage,
  RevisionProposalRecord,
  RevisionProposalRequest,
  RevisionSummary,
  StatementDetailDTO,
  StatementStatusWire,
  StatementsResponse,
  StateOverviewResponse,
  StatusWatcher,
  SearchResponseDto,
  CrossSearchResponseDto,
  MountAcceptedDto,
  MountListResponseDto,
  StorageStatsResponse,
  TrashFileRequest,
  UpdateStoragePolicyResponse,
  WorkspaceStatusResponse,
} from './apiTypes';
import type {
  ContentRole,
  CoverageKind,
  FileFormat,
  FileRecord,
  Revision,
} from '../types/guanlan';
import { requestRevisionContentsBatch } from '../utils/revisionContentStore';
import { formatByteSize } from '../utils/formatMeta';

export type {
  BootstrapResponse,
  CasConflictDetail,
  CheckpointCommitRequest,
  CheckpointCommitResult,
  CheckpointRecord,
  CheckpointsPage,
  ContextRequest,
  ContextResponse,
  DecisionResolveAccepted,
  DecisionResolveRequest,
  DiffJobRequest,
  DiffResult,
  DecisionsResponse,
  FileSummaryDetailResponse,
  FileMutationResponse,
  IndexJobAccepted,
  IndexJobStatus,
  InitiativeJobAccepted,
  InitiativeTasksResponse,
  JobAccepted,
  JobCancelResult,
  JobReportAdopt,
  JobReportDismiss,
  JobReportOrphanRepair,
  JobReportWriteback,
  JobResultResponse,
  L4aProgress,
  McpHostConfigRequest,
  McpHostConfigResponse,
  MoveFileRequest,
  OrphanRepairRequest,
  ReviewBoardResponse,
  EventDayGroup,
  EventDayItem,
  EventDaysResult,
  EventPage,
  EventPageItem,
  EventTimeRange,
  FileFacets,
  FileRevisionsResponse,
  FileSummary,
  FileSummaryPage,
  ImagePreviewMeta,
  RelationsResponse,
  RenameFileRequest,
  RevisionPreviewHistoryItem,
  RevisionPreviewKind,
  RevisionPreviewResponse,
  RevisionProposalAccepted,
  RevisionProposalContentResponse,
  RevisionProposalPage,
  RevisionProposalRecord,
  RevisionProposalRequest,
  RevisionSummary,
  StatementDetailDTO,
  StatementStatusWire,
  StatementsResponse,
  StateOverviewResponse,
  StatusWatcher,
  StorageStatsResponse,
  TrashFileRequest,
  UpdateStoragePolicyResponse,
  WorkspaceStatusResponse,
};

/** 桶粒度：day（逐日）/ week（周一为桶键）/ month（YYYY-MM） */
export type EventDayGranularity = EventDaysResult['granularity'];


const injectedApiBase =
  typeof window !== 'undefined' && typeof (window as { __GUANLAN_API__?: unknown }).__GUANLAN_API__ === 'string'
    ? ((window as { __GUANLAN_API__?: string }).__GUANLAN_API__ as string)
    : '';
let apiBase = injectedApiBase.replace(/\/+$/, '');

export function setApiBaseUrl(base: string): void {
  apiBase = base.replace(/\/+$/, '');
}

export function getApiBaseUrl(): string {
  return apiBase;
}

/** 将服务端返回的相对 /api/v1/... 路径绑定到当前运行端点（兼容 Tauri 跨源 WebView） */
export function resolveApiUrl(path: string): string {
  if (!path) return '';
  if (/^https?:\/\//i.test(path)) return path;
  return apiBase ? `${apiBase}${path.startsWith('/') ? '' : '/'}${path}` : path;
}

/** 统一错误包络（{ ok:false, code, error, detail?, index_generation? }） */
export interface ErrorEnvelopeBody {
  ok: false;
  code?: string;
  error?: string;
  detail?: string;
  index_generation?: number;
}

interface RawResponse {
  status: number;
  data: Record<string, unknown> | null;
  errorBody: ErrorEnvelopeBody | null;
  aborted?: boolean;
}

async function requestJson(path: string, signal?: AbortSignal): Promise<RawResponse> {
  try {
    const res = await fetch(`${apiBase}${path}`, {
      headers: { Accept: 'application/json' },
      signal,
    });
    let body: Record<string, unknown> | null = null;
    let errorBody: ErrorEnvelopeBody | null = null;
    try {
      const parsed = (await res.json()) as unknown;
      if (parsed && typeof parsed === 'object') {
        body = parsed as Record<string, unknown>;
        if (!res.ok) errorBody = body as unknown as ErrorEnvelopeBody;
      }
    } catch {
    }
    return { status: res.status, data: body, errorBody };
  } catch (err) {
    const isAbort =
      (signal && signal.aborted) ||
      (err instanceof Error && err.name === 'AbortError');
    return { status: 0, data: null, errorBody: null, aborted: isAbort };
  }
}

function networkErrorText(raw: RawResponse): string {
  return raw.status === 0
    ? '无法连接观澜读服务（/api/v1）'
    : `读服务暂时不可用（${raw.status}）`;
}

async function requestJsonPost(path: string, body: unknown): Promise<RawResponse> {
  try {
    const res = await fetch(`${apiBase}${path}`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    let parsedBody: Record<string, unknown> | null = null;
    let errorBody: ErrorEnvelopeBody | null = null;
    try {
      const parsed = (await res.json()) as unknown;
      if (parsed && typeof parsed === 'object') {
        parsedBody = parsed as Record<string, unknown>;
        if (!res.ok) errorBody = parsedBody as unknown as ErrorEnvelopeBody;
      }
    } catch {
    }
    return { status: res.status, data: parsedBody, errorBody };
  } catch {
    return { status: 0, data: null, errorBody: null };
  }
}

async function requestJsonPatch(path: string, body: unknown): Promise<RawResponse> {
  try {
    const res = await fetch(`${apiBase}${path}`, {
      method: 'PATCH',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    let parsedBody: Record<string, unknown> | null = null;
    let errorBody: ErrorEnvelopeBody | null = null;
    try {
      const parsed = (await res.json()) as unknown;
      if (parsed && typeof parsed === 'object') {
        parsedBody = parsed as Record<string, unknown>;
        if (!res.ok) errorBody = parsedBody as unknown as ErrorEnvelopeBody;
      }
    } catch {
    }
    return { status: res.status, data: parsedBody, errorBody };
  } catch {
    return { status: 0, data: null, errorBody: null };
  }
}

async function requestJsonDelete(path: string): Promise<RawResponse> {
  try {
    const res = await fetch(`${apiBase}${path}`, {
      method: 'DELETE',
      headers: { Accept: 'application/json' },
    });
    let parsedBody: Record<string, unknown> | null = null;
    let errorBody: ErrorEnvelopeBody | null = null;
    try {
      const parsed = (await res.json()) as unknown;
      if (parsed && typeof parsed === 'object') {
        parsedBody = parsed as Record<string, unknown>;
        if (!res.ok) errorBody = parsedBody as unknown as ErrorEnvelopeBody;
      }
    } catch {
    }
    return { status: res.status, data: parsedBody, errorBody };
  } catch {
    return { status: 0, data: null, errorBody: null };
  }
}

/** 统一成功/失败结果（可判别联合：ok:true 时 data 必非空，调用方可直接窄化） */
export type ApiResult<T> =
  | {
      ok: true;
      data: T;
      status?: number;
    }
  | {
      ok: false;
      data: null;
      status?: number;
      code?: string;
      error?: string;
    };

function toResult<T>(raw: RawResponse): ApiResult<T> {
  const body = raw.data;
  if (raw.status >= 200 && raw.status < 300 && body && body.ok === true) {
    return { ok: true, data: body as unknown as T, status: raw.status };
  }
  if (raw.aborted) {
    return {
      ok: false,
      data: null,
      status: 0,
      code: 'ABORTED',
      error: '请求已取消',
    };
  }
  return {
    ok: false,
    data: null,
    status: raw.status,
    code: raw.errorBody?.code,
    error: raw.errorBody?.error || networkErrorText(raw),
  };
}


export interface BootstrapQuery {
  daysLimit?: number;
  daysSamples?: number;
  daysGranularity?: 'day' | 'week' | 'month';
  filesPageSize?: number;
  eventsLimit?: number;
}

export async function fetchBootstrap(
  query: BootstrapQuery = {}
): Promise<ApiResult<BootstrapResponse>> {
  const params = new URLSearchParams();
  if (query.daysLimit) params.set('days_limit', String(query.daysLimit));
  if (query.daysSamples) params.set('days_samples', String(query.daysSamples));
  if (query.daysGranularity) params.set('days_granularity', query.daysGranularity);
  if (query.filesPageSize) params.set('files_page_size', String(query.filesPageSize));
  if (query.eventsLimit) params.set('events_limit', String(query.eventsLimit));
  const qs = params.toString();
  const suffix = qs ? `?${qs}` : '';
  return toResult<BootstrapResponse>(await requestJson(`/api/v1/bootstrap${suffix}`));
}


export interface FileSummariesQuery {
  dir?: string;
  format?: FileFormat;
  matter?: string;
  q?: string;
  status?: 'active' | 'trashed' | 'missing' | 'recoverable' | 'all';
  limit?: number;
  cursor?: string | null;
}

/** 单页文件摘要；snapshot_generation 与当前代际不符时服务端返回 CURSOR_STALE */
export async function fetchFileSummaries(
  query: FileSummariesQuery = {}
): Promise<ApiResult<FileSummaryPage>> {
  const params = new URLSearchParams();
  if (query.dir) params.set('dir', query.dir);
  if (query.format) params.set('format', query.format);
  if (query.matter) params.set('matter', query.matter);
  if (query.q) params.set('q', query.q);
  if (query.status) params.set('status', query.status);
  if (query.limit) params.set('limit', String(query.limit));
  if (query.cursor) params.set('cursor', query.cursor);
  const qs = params.toString();
  const suffix = qs ? `?${qs}` : '';
  return toResult<FileSummaryPage>(await requestJson(`/api/v1/files${suffix}`));
}

export interface AllFileSummariesResult {
  ok: boolean;
  items: FileSummary[];
  total_matched?: number;
  facets?: FileFacets;
  code?: string;
  error?: string;
}

/**
 * 遍历拉取全部分页文件摘要（后台续载用：bootstrap 只带首批）。
 * 游标失效（CURSOR_STALE）时保留已取回页并从头重走（可变列表游标语义）；
 * onPage 在每页到达时回调，供调用方增量合并缓存。
 */
export async function fetchAllFileSummaries(
  query: FileSummariesQuery = {},
  onPage?: (page: FileSummaryPage) => void
): Promise<AllFileSummariesResult> {
  const items: FileSummary[] = [];
  const seenIds = new Set<string>();
  let total_matched: number | undefined;
  let facets: FileFacets | undefined;
  const startCursor = query.cursor ?? null;
  for (let attempt = 0; attempt < 3; attempt++) {
    let cursor: string | null = attempt === 0 ? startCursor : null;
    let failed: ApiResult<FileSummaryPage> | null = null;
    for (let pageGuard = 0; pageGuard < 1000; pageGuard++) {
      const page = await fetchFileSummaries({ ...query, cursor });
      if (!page.ok) {
        failed = page;
        break;
      }
      const data = page.data;
      total_matched = data.total_matched;
      facets = data.facets ?? facets;
      if (onPage) onPage(data);
      for (const item of data.items) {
        if (seenIds.has(item.file_id)) continue;
        seenIds.add(item.file_id);
        items.push(item);
      }
      if (!data.has_more || !data.next_cursor) {
        return { ok: true, items, total_matched, facets };
      }
      cursor = data.next_cursor;
    }
    if (failed && failed.code !== 'CURSOR_STALE' && failed.code !== 'INDEX_STALE') {
      return {
        ok: false,
        items,
        total_matched,
        facets,
        code: failed.code,
        error: failed.error,
      };
    }
  }
  return {
    ok: false,
    items,
    total_matched,
    facets,
    code: 'CURSOR_STALE',
    error: '文件列表游标反复失效，已保留已取回部分',
  };
}


export interface EventPageQuery {
  from?: string;
  to?: string;
  kinds?: string[];
  format?: FileFormat;
  order?: 'occurred' | 'observed';
  undated?: boolean;
  q?: string;
  limit?: number;
  cursor?: string | null;
}

export interface EventPageResult {
  page: EventPage | null;
  stale: boolean;
  code?: string;
  error?: string;
}

/**
 * 分页拉取工程事件；游标绑定筛选与首次查询时的最大事件序号（snapshot_max_seq）。
 * 续页必须携带与首页完全一致的筛选参数（kinds 参与 SHA-256 指纹，漏传被判 CURSOR_STALE）。
 */
export async function fetchEventPage(query: EventPageQuery = {}): Promise<EventPageResult> {
  const params = new URLSearchParams();
  if (query.from) params.set('from', query.from);
  if (query.to) params.set('to', query.to);
  if (query.kinds && query.kinds.length) params.set('kinds', query.kinds.join(','));
  if (query.format) params.set('format', query.format);
  if (query.order) params.set('order', query.order);
  if (query.undated) params.set('undated', '1');
  if (query.q) params.set('q', query.q);
  if (query.limit) params.set('limit', String(query.limit));
  if (query.cursor) params.set('cursor', query.cursor);
  const result = toResult<EventPage>(await requestJson(`/api/v1/events?${params.toString()}`));
  if (result.ok) {
    return { page: result.data, stale: false };
  }
  const stale = result.code === 'CURSOR_STALE' || result.code === 'INDEX_STALE';
  return { page: null, stale, code: result.code, error: result.error };
}

export interface EventDaysQuery {
  from?: string;
  to?: string;
  kinds?: string[];
  format?: FileFormat;
  order?: 'occurred' | 'observed';
  granularity?: EventDayGranularity;
  limitDays?: number;
  samplesPerDay?: number;
}

/** 按日/周/月聚合事件：画布日期标尺、每日折叠组与首屏卡片密度（无游标、无 snapshot 绑定） */
export async function fetchEventDays(query: EventDaysQuery = {}): Promise<EventDaysResult | null> {
  const params = new URLSearchParams();
  if (query.from) params.set('from', query.from);
  if (query.to) params.set('to', query.to);
  if (query.kinds && query.kinds.length) params.set('kinds', query.kinds.join(','));
  if (query.format) params.set('format', query.format);
  if (query.order) params.set('order', query.order);
  if (query.granularity) params.set('granularity', query.granularity);
  if (query.limitDays) params.set('limit_days', String(query.limitDays));
  if (query.samplesPerDay) params.set('samples', String(query.samplesPerDay));
  const result = toResult<EventDaysResult>(
    await requestJson(`/api/v1/events/days?${params.toString()}`)
  );
  return result.ok ? result.data : null;
}


export interface FileHistoryRevision {
  revision_id: string;
  seq: number;
  prev_revision_id: string | null;
  content_hash: string;
  size_bytes: number;
  observed_at: string;
  occurred_at: string | null;
  occurred_precision: string;
  occurred_source: string | null;
  snapshot_available: boolean;
}

/** 版本链相关事件行（include=events；字段沿用旧 /history wire，payload 含 changed_sections 等） */
export interface FileHistoryEvent {
  seq: number;
  event_id: string;
  kind: string;
  revision_id: string | null;
  occurred_at: string | null;
  occurred_precision: string;
  occurred_source: string | null;
  observed_at: string;
  headline: string;
  detail: string;
  payload: Record<string, unknown>;
}

export interface FileHistory {
  ok: boolean;
  file: {
    file_id: string;
    current_path: string;
    title: string;
    format: string;
    role: string;
    status: string;
    first_observed_at: string;
    last_observed_at: string;
    last_revision_id: string | null;
  };
  revisions: FileHistoryRevision[];
  events: FileHistoryEvent[];
  statements: Array<{
    statement_id: string;
    revision_id: string;
    code: string;
    question: string;
    status: string;
    line_start: number;
    line_end: number;
    decision_id: string | null;
  }>;
  edges: Array<{
    edge_id: string;
    source_revision_id: string;
    target_file_id: string;
    target_revision_id: string | null;
    resolution: string;
    locator_start: number | null;
    reason: string;
  }>;
  aliases?: string[];
}

export interface FileRevisionsPageQuery {
  order?: 'seq_asc' | 'seq_desc';
  include?: Array<'events' | 'statements' | 'edges' | 'aliases'>;
  limit?: number;
  cursor?: string | null;
}

/** 单页版本链；文件不存在返回 NOT_FOUND */
export async function fetchFileRevisionsPage(
  fileId: string,
  query: FileRevisionsPageQuery = {}
): Promise<ApiResult<FileRevisionsResponse>> {
  const params = new URLSearchParams();
  if (query.order) params.set('order', query.order);
  if (query.include && query.include.length) params.set('include', query.include.join(','));
  if (query.limit) params.set('limit', String(query.limit));
  if (query.cursor) params.set('cursor', query.cursor);
  const result = toResult<FileRevisionsResponse>(
    await requestJson(`/api/v1/files/${encodeURIComponent(fileId)}/revisions?${params.toString()}`)
  );
  return result;
}

/**
 * 单文件版本链整链读取：内部遍历分页（单文件版本数有限，seq_asc 保持按版本序排列），
 * include 附集合仅在首页请求（文件级集合一次带回，revisions 分页；续页不再发送）。
 * 返回 null 表示读取失败（含 NOT_FOUND / 服务未启动）。
 */
export async function fetchFileHistory(fileId: string): Promise<FileHistory | null> {
  let file: FileHistory['file'] | null = null;
  const revisions: FileHistoryRevision[] = [];
  let events: FileHistoryEvent[] = [];
  let statements: FileHistory['statements'] = [];
  let edges: FileHistory['edges'] = [];
  let aliases: string[] = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    revisions.length = 0;
    events = [];
    statements = [];
    edges = [];
    aliases = [];
    file = null;
    let cursor: string | null = null;
    let failed: ApiResult<FileRevisionsResponse> | null = null;
    for (let pageGuard = 0; pageGuard < 1000; pageGuard++) {
      const page = await fetchFileRevisionsPage(fileId, {
        order: 'seq_asc',
        include: cursor ? undefined : ['events', 'statements', 'edges', 'aliases'],
        limit: 200,
        cursor,
      });
      if (!page.ok) {
        failed = page;
        break;
      }
      const data = page.data;
      file = {
        file_id: data.file.file_id,
        current_path: data.file.current_path,
        title: data.file.title,
        format: data.file.format,
        role: data.file.role,
        status: data.file.status,
        first_observed_at: data.file.first_observed_at,
        last_observed_at: data.file.last_observed_at,
        last_revision_id: data.file.last_revision_id,
      };
      revisions.push(
        ...data.revisions.map((r): FileHistoryRevision => ({
          revision_id: r.revision_id,
          seq: r.seq,
          prev_revision_id: r.prev_revision_id,
          content_hash: r.content_hash,
          size_bytes: r.size_bytes,
          observed_at: r.observed_at,
          occurred_at: r.occurred_at,
          occurred_precision: r.occurred_precision,
          occurred_source: r.occurred_source,
          snapshot_available: r.snapshot_available,
        }))
      );
      if (!cursor) {
        events = (data.events as FileHistoryEvent[] | undefined) ?? [];
        statements = (data.statements as FileHistory['statements'] | undefined) ?? [];
        edges = (data.edges as FileHistory['edges'] | undefined) ?? [];
        aliases = data.aliases ?? [];
      }
      if (!data.has_more || !data.next_cursor) {
        failed = null;
        break;
      }
      cursor = data.next_cursor;
    }
    if (!failed) {
      if (!file) return null;
      return { ok: true, file, revisions, events, statements, edges, aliases };
    }
    if (failed.code !== 'CURSOR_STALE' && failed.code !== 'INDEX_STALE') {
      return null;
    }
  }
  return null;
}

export interface RevisionContentResult {
  ok: boolean;
  format?: string;
  text?: string;
  raw_url?: string;
  code?: string;
  error?: string;
}

/** 按版本读取正文的错误码说明：
 *  - `SNAPSHOT_UNAVAILABLE`：快照已过保留期（换仍保留快照的版本阅读）；
 *  - `UNSUPPORTED_CONTENT`：正文超过服务端内联上限（改用 `raw=1` 流式地址）；
 *  - `INDEX_BUSY`：服务端响应预算饱和（可重试）。 */
export async function fetchRevisionContent(revisionId: string): Promise<RevisionContentResult> {
  const result = toResult<RevisionContentResponse>(
    await requestJson(`/api/v1/revisions/${encodeURIComponent(revisionId)}/content`)
  );
  if (result.ok) {
    return {
      ok: true,
      format: result.data.format,
      text: result.data.text,
      raw_url: result.data.raw_url ? resolveApiUrl(result.data.raw_url) : undefined,
    };
  }
  return { ok: false, code: result.code, error: result.error };
}

/** 按版本的 PDF / 资源原始地址（不用当前工作区路径，避免版本漂移；raw=1，自动绑定当前 apiBase 以兼容 Tauri WebView） */
export function revisionRawUrl(revisionId: string): string {
  return resolveApiUrl(`/api/v1/revisions/${encodeURIComponent(revisionId)}/content?raw=1`);
}

/** QuickLook 图像/矢量流式缩略地址（自动绑定当前工作区 apiBase，兼容 Tauri WebView） */
export function revisionThumbnailUrl(revisionId: string): string {
  return resolveApiUrl(`/api/v1/revisions/${encodeURIComponent(revisionId)}/thumbnail`);
}

export interface RevisionPreviewFetchOptions {
  offset?: number;
  maxBytes?: number;
  signal?: AbortSignal;
}

/** QuickLook L1 轻预览查询（默认仅读 64KiB 分片/头部元数据，支持 AbortSignal 防竞态） */
export async function fetchRevisionPreview(
  revisionId: string,
  opts: RevisionPreviewFetchOptions = {}
): Promise<ApiResult<RevisionPreviewResponse>> {
  const qs = new URLSearchParams();
  if (typeof opts.offset === 'number' && opts.offset > 0) {
    qs.set('offset', String(Math.floor(opts.offset)));
  }
  if (typeof opts.maxBytes === 'number' && opts.maxBytes > 0) {
    qs.set('max_bytes', String(Math.floor(opts.maxBytes)));
  }
  const suffix = qs.toString();
  const path = `/api/v1/revisions/${encodeURIComponent(revisionId)}/preview${
    suffix ? `?${suffix}` : ''
  }`;
  return toResult<RevisionPreviewResponse>(await requestJson(path, opts.signal));
}

/** Office（.docx/.xlsx）L2 结构化内容查询 */
export async function fetchRevisionOffice(
  revisionId: string,
  signal?: AbortSignal
): Promise<ApiResult<import('./apiTypes').OfficeContentResponse>> {
  return toResult<import('./apiTypes').OfficeContentResponse>(
    await requestJson(`/api/v1/revisions/${encodeURIComponent(revisionId)}/office`, signal)
  );
}

/** 候选事项列表（多信号编织，含理由胶囊） */
export async function fetchInitiativeCandidates(
  signal?: AbortSignal
): Promise<ApiResult<import('./apiTypes').InitiativeCandidatesResponse>> {
  return toResult<import('./apiTypes').InitiativeCandidatesResponse>(
    await requestJson('/api/v1/initiative-candidates', signal)
  );
}

/** 候选采纳（202 + JobAccepted；建/并入正式事项并固化归属） */
export async function adoptInitiativeCandidate(
  candidateId: string
): Promise<ApiResult<{ ok: boolean; job_id: string }>> {
  return toResult<{ ok: boolean; job_id: string }>(
    await requestJsonPost(`/api/v1/initiative-candidates/${encodeURIComponent(candidateId)}/adopt`, {})
  );
}

/** 候选整簇否决（202；信号对排除，重扫不反弹） */
export async function dismissInitiativeCandidate(
  candidateId: string
): Promise<ApiResult<{ ok: boolean; job_id: string }>> {
  return toResult<{ ok: boolean; job_id: string }>(
    await requestJsonPost(`/api/v1/initiative-candidates/${encodeURIComponent(candidateId)}/dismiss`, {})
  );
}

/** 候选单成员剔除（202；与簇内成员两两排除，<2 人簇失效） */
export async function excludeInitiativeCandidateMember(
  candidateId: string,
  fileId: string
): Promise<ApiResult<{ ok: boolean; job_id: string }>> {
  return toResult<{ ok: boolean; job_id: string }>(
    await requestJsonPost(
      `/api/v1/initiative-candidates/${encodeURIComponent(candidateId)}/members/${encodeURIComponent(fileId)}/exclude`,
      {}
    )
  );
}

/** PDF 页级正文查询（页码证据直达） */
export async function fetchRevisionPdf(
  revisionId: string,
  signal?: AbortSignal
): Promise<ApiResult<import('./apiTypes').PdfContentResponse>> {
  return toResult<import('./apiTypes').PdfContentResponse>(
    await requestJson(`/api/v1/revisions/${encodeURIComponent(revisionId)}/pdf`, signal)
  );
}

/**
 * 批量按需拉取版本正文（仅限当前文件版本链范围调用，如阅读器版次对比的两版正文）。
 * existing 中已有的 revision_id 跳过；SNAPSHOT_UNAVAILABLE 等失败项写入 failed，不污染正文缓存。
 * 请求协调与字节预算统一走 revisionContentStore——同版本并发读取合并为一次底层请求，
 * ready 条目直接回填，失败不永久锁死。
 */
export async function fetchRevisionContentsBatch(
  revisionIds: string[],
  existing: Record<string, string> = {},
  concurrency = 8
): Promise<{ contents: Record<string, string>; failed: Record<string, string> }> {
  return requestRevisionContentsBatch(revisionIds, fetchRevisionContent, {
    existing,
    concurrency,
  });
}


/** 全量文件引用边 */
export async function fetchRelations(): Promise<ApiResult<RelationsResponse>> {
  return toResult<RelationsResponse>(await requestJson('/api/v1/relations'));
}


/** 从 SVG 源提取 <text> 文本节点（镜像 server/project.ts:433-448 extractSvgText） */
export function extractSvgTextNodes(source: string): string[] {
  const out: string[] = [];
  const re = /<text[^>]*>([\s\S]*?)<\/text>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    const text = m[1]
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .trim();
    if (text) out.push(text);
  }
  return out;
}

/** 相对路径 → 目录（镜像 server/project.ts folderOf：分隔符归一、去文件名、根目录为 '.'） */
export function folderOfRelativePath(relativePath: string): string {
  const segments = relativePath.replace(/\\/g, '/').split('/');
  segments.pop();
  return segments.join('/') || '.';
}

/** 文件摘要 → 资产库 FileRecord（镜像 project.ts:189-206 的 active 投影） */
export function fileSummaryToFileRecord(item: FileSummary): FileRecord {
  const placeholder: Revision | null = item.current_revision_id
    ? {
        revision_id: item.current_revision_id,
        file_id: item.file_id,
        versionNumber: item.revision_count || 1,
        content_sha256: '',
        observed_at: item.last_observed_at,
        source_time: item.first_source_time || undefined,
        sizeBytes: 0,
        snapshotAvailable: item.snapshot_available,
        summaryNote: '',
      }
    : null;
  return {
    file_id: item.file_id,
    relative_path: item.relative_path,
    title: item.title,
    format: item.format,
    folder: item.folder,
    role: item.role as ContentRole,
    roleProvenance: '来自路径',
    topics: [],
    current_revision_id: item.current_revision_id || '',
    revisions: placeholder ? [placeholder] : [],
    coverage: item.coverage as CoverageKind,
    pdfStatus: item.format === 'pdf' ? 'unindexed' : undefined,
    pdfStatusReason:
      item.format === 'pdf'
        ? '正文尚未索引，当前仅文件名与元数据可检索（阅读器可打开原文件预览）'
        : undefined,
  };
}

/**
 * 版本链（snake_case RevisionSummary[]，seq ASC）→ camelCase Revision[]。
 * 镜像 project.ts:132-172 toRevision：
 * - versionNumber = seq（修订链顺序，服务端 per-file seq 即版本号）；
 * - source_time = occurred_at（文档记载时间；严禁拿 observed_at 冒充）；
 * - changedSectionsFromPrev 来自 modified 事件 payload.changed_sections；
 * - summaryNote 组装口径与旧 /scan 逐字一致。
 */
export function revisionsFromHistory(
  fileId: string,
  revisions: RevisionSummary[],
  events: FileHistoryEvent[]
): Revision[] {
  const changedSectionsByRevision = new Map<string, string[]>();
  for (const ev of events) {
    if (!ev.revision_id) continue;
    const payload = (ev.payload || {}) as Record<string, unknown>;
    if (Array.isArray(payload.changed_sections) && payload.changed_sections.length) {
      changedSectionsByRevision.set(ev.revision_id, payload.changed_sections as string[]);
    }
  }

  return revisions.map((rev) => {
    const summaryParts = [`v${rev.seq}`];
    if (rev.occurred_at) {
      summaryParts.push(
        rev.occurred_precision === 'day'
          ? `${rev.occurred_at}（原文记载）`
          : `${rev.occurred_at.replace('T', ' ').slice(0, 19)}（${
              rev.occurred_source === 'file_mtime'
                ? '文件修改时间'
                : rev.occurred_source === 'document_self'
                  ? '文档自述'
                  : '采集'
            }）`
      );
    } else {
      summaryParts.push('日期待考');
    }
    summaryParts.push(formatByteSize(rev.size_bytes));
    if (!rev.snapshot_available) summaryParts.push('快照已过保留期');

    return {
      revision_id: rev.revision_id,
      file_id: fileId,
      versionNumber: rev.seq,
      content_sha256: rev.content_hash,
      observed_at: rev.observed_at,
      source_time: rev.occurred_at || undefined,
      sizeBytes: rev.size_bytes,
      snapshotAvailable: rev.snapshot_available,
      isBaselineProtected: rev.seq === 1,
      changedSectionsFromPrev: changedSectionsByRevision.get(rev.revision_id),
      summaryNote: summaryParts.join(' · '),
    };
  });
}



/** 首屏摘要（App 由 bootstrap 的 counts/baseline/time_range 组装；HomeView 消费） */
export interface WorkspaceSummary {
  ok: boolean;
  workspace_id: string;
  root_path: string;
  data_dir?: string;
  index_generation: number;
  last_scan_at: string | null;
  baseline: boolean;
  counts: {
    files: number;
    revisions: number;
    events: number;
    blobs: number;
    statements: number;
    edges: number;
  };
  time_range: EventTimeRange;
}

/** 数据同步三态胶囊的 real|error 分支（TopHeader 消费；loading 由 App 本地状态补充） */
export type WorkspaceSource = 'real' | 'error';

export interface WorkspaceChangeNotice {
  type: 'hello' | 'workspace-change';
  generation?: number;
  index_generation?: number;
  newEvents?: number;
  newRevisions?: number;
  new_events?: number;
  new_revisions?: number;
  at?: string;
  watching?: boolean;
  paths?: string[];
  kinds?: string[];
}

/**
 * 订阅工作区变化（/api/v1/stream 发送具名 SSE 事件 `hello` / `workspace-change`）。
 * EventSource.onmessage 仅接收未命名事件，因此必须显式注册 `workspace-change` / `hello` 监听器。
 */
export function subscribeWorkspaceStream(
  onNotice: (notice: WorkspaceChangeNotice) => void,
  onConnectionChange?: (connected: boolean) => void
): () => void {
  if (typeof EventSource === 'undefined') return () => {};
  const source = new EventSource(`${apiBase}/api/v1/stream`);
  const handleOpen = () => {
    onConnectionChange?.(true);
  };
  const handleError = () => {
    onConnectionChange?.(false);
  };
  const handleMessage = (event: MessageEvent) => {
    onConnectionChange?.(true);
    try {
      const parsed = JSON.parse(String(event.data)) as WorkspaceChangeNotice;
      if (parsed.newEvents === undefined && typeof parsed.new_events === 'number') {
        parsed.newEvents = parsed.new_events;
      }
      if (parsed.newRevisions === undefined && typeof parsed.new_revisions === 'number') {
        parsed.newRevisions = parsed.new_revisions;
      }
      onNotice(parsed);
    } catch {
    }
  };
  source.addEventListener('open', handleOpen);
  source.addEventListener('error', handleError);
  source.addEventListener('hello', handleMessage as EventListener);
  source.addEventListener('workspace-change', handleMessage as EventListener);
  source.onmessage = handleMessage;
  return () => {
    source.removeEventListener('open', handleOpen);
    source.removeEventListener('error', handleError);
    source.removeEventListener('hello', handleMessage as EventListener);
    source.removeEventListener('workspace-change', handleMessage as EventListener);
    source.close();
  };
}


/** 索引任务类型（外部可提四类）。
 *
 * - `verify_all`：整库核验（单飞合并）；
 * - `changed_paths`：增量对账（paths 必填 ≤2000 条，同类 active 任务合并去重）；
 * - `l4a_summary`：L4A 沉淀（paths 指定文件）；
 * - `set_initiative_dirs`：专项目录设置（dirs 必填 ≤64 条，写入 meta.initiative_dirs，
 *   幂等覆盖——供工作区无 `\d{2}-` 目录时手动指定专项目录）。
 *
 * 内部 kind（decision_writeback / propose_revision / adopt_draft / archive_initiative /
 * reopen_initiative / diff / checkpoint_commit）外部直提一律 400『未知任务类型』；
 * checkpoint_commit 经同步命令通道（POST /checkpoints），不占 job。 */
export type IndexJobKind = 'verify_all' | 'changed_paths' | 'l4a_summary' | 'set_initiative_dirs';

export interface StartIndexJobPayload {
  paths?: string[];
  dirs?: string[];
}

/** 提交索引任务：立即 202 + job_id（per-kind 合并语义在服务端，
 *  受理响应沿用 IndexJobAccepted.merged 回显是否并入已有任务） */
export async function startIndexJob(
  kind: IndexJobKind = 'verify_all',
  payload: StartIndexJobPayload = {}
): Promise<ApiResult<IndexJobAccepted>> {
  return toResult<IndexJobAccepted>(
    await requestJsonPost('/api/v1/index-jobs', { kind, ...payload })
  );
}


export async function postRenameFile(
  fileId: string,
  newName: string
): Promise<ApiResult<FileMutationResponse>> {
  const body: RenameFileRequest = { new_name: newName };
  return toResult<FileMutationResponse>(
    await requestJsonPost(`/api/v1/files/${encodeURIComponent(fileId)}/rename`, body)
  );
}

export async function postMoveFile(
  fileId: string,
  targetDir: string,
  newName?: string
): Promise<ApiResult<FileMutationResponse>> {
  const body: MoveFileRequest =
    newName && newName.trim().length > 0
      ? { target_dir: targetDir, new_name: newName }
      : { target_dir: targetDir };
  return toResult<FileMutationResponse>(
    await requestJsonPost(`/api/v1/files/${encodeURIComponent(fileId)}/move`, body)
  );
}

export async function postTrashFile(
  fileId: string,
  confirm: boolean
): Promise<ApiResult<FileMutationResponse>> {
  const body: TrashFileRequest = { confirm };
  return toResult<FileMutationResponse>(
    await requestJsonPost(`/api/v1/files/${encodeURIComponent(fileId)}/trash`, body)
  );
}

/** 专项目录设置：POST /index-jobs kind=set_initiative_dirs 幂等覆盖 */
export async function postSetInitiativeDirs(dirs: string[]): Promise<ApiResult<IndexJobAccepted>> {
  return startIndexJob('set_initiative_dirs', { dirs });
}


export async function fetchStorageStats(): Promise<ApiResult<StorageStatsResponse>> {
  return toResult<StorageStatsResponse>(await requestJson('/api/v1/storage/stats'));
}

export async function updateStoragePolicy(
  textMaxMiB: number,
  binaryMaxMiB: number
): Promise<ApiResult<UpdateStoragePolicyResponse>> {
  return toResult<UpdateStoragePolicyResponse>(
    await requestJsonPost('/api/v1/storage/policy', {
      text_max_mib: textMaxMiB,
      binary_max_mib: binaryMaxMiB,
    })
  );
}


/** 四视图唯一数据源（专项卡片 / 专项详情下拉 / 星图节点 / 文档顶栏）；
 *  initiative_id 缺省 = 全量专项。 */
export async function fetchStateOverview(
  initiativeId?: string
): Promise<ApiResult<StateOverviewResponse>> {
  const suffix = initiativeId
    ? `?initiative_id=${encodeURIComponent(initiativeId)}`
    : '';
  return toResult<StateOverviewResponse>(
    await requestJson(`/api/v1/state-overview${suffix}`)
  );
}


/** 结构化上下文 + Markdown 导出同源生成（items 缺省/空时由服务端按三入口默认包组装） */
export async function postContext(body: ContextRequest): Promise<ApiResult<ContextResponse>> {
  return toResult<ContextResponse>(await requestJsonPost('/api/v1/context', body));
}

/** 主流宿主（ZCode / Claude Code / Cursor）.mcp.json 安全预览/原子合并写入 */
export async function postMcpHostConfig(
  body: McpHostConfigRequest
): Promise<ApiResult<McpHostConfigResponse>> {
  return toResult<McpHostConfigResponse>(await requestJsonPost('/api/v1/mcp/host-config', body));
}

/** 拉取批阅看板（五态精简版 + 失联/无回执 unknown 诚实诊断） */
export async function fetchReviewBoard(params: {
  stallThresholdSecs?: number;
} = {}): Promise<ApiResult<ReviewBoardResponse>> {
  const qs = new URLSearchParams();
  if (params.stallThresholdSecs && params.stallThresholdSecs > 0) {
    qs.set('stall_threshold_secs', String(params.stallThresholdSecs));
  }
  const suffix = qs.toString() ? `?${qs.toString()}` : '';
  return toResult<ReviewBoardResponse>(await requestJson(`/api/v1/review-board${suffix}`));
}

/** 提交失联/孤儿节点人工修复任务（仅允许 reset_to_dispatchable / mark_suspended_hitl） */
export async function postRepairOrphan(
  initiativeId: string,
  body: OrphanRepairRequest
): Promise<ApiResult<JobAccepted>> {
  return toResult<JobAccepted>(
    await requestJsonPost(
      `/api/v1/review-board/${encodeURIComponent(initiativeId)}/repair-orphan`,
      body
    )
  );
}

/** 返回当前本地回环服务端点（用于宿主 .mcp.json 零冷启动写入；无回环时回退默认端口） */
export function getActiveLoopbackEndpoint(): string {
  const base = getApiBaseUrl().trim().replace(/\/+$/, '');
  if (/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(base)) return base;
  if (typeof window !== 'undefined' && window.location?.origin) {
    const origin = window.location.origin.trim().replace(/\/+$/, '');
    if (/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(origin)) return origin;
  }
  return 'http://127.0.0.1:39120';
}


/** 决策列表：SSE decision_writeback 后取最新决策（不限状态），
 *  生成《最新已拍板决策变更单》；status 传库内词（如「已确认」）时精确过滤。 */
export async function fetchDecisions(query: {
  status?: string;
  code?: string;
  q?: string;
  cursor?: string;
  limit?: number;
} = {}): Promise<ApiResult<DecisionsResponse>> {
  const params = new URLSearchParams();
  if (query.status) params.set('status', query.status);
  if (query.code) params.set('code', query.code);
  if (query.q) params.set('q', query.q);
  if (query.cursor) params.set('cursor', query.cursor);
  if (query.limit) params.set('limit', String(query.limit));
  const qs = params.toString();
  return toResult<DecisionsResponse>(
    await requestJson(`/api/v1/decisions${qs ? `?${qs}` : ''}`)
  );
}

/** 拍板表单数据源：status 传 wire 词（服务端映射库内中文词），不传 = 全部 */
export async function fetchStatements(query: {
  file_id?: string;
  status?: StatementStatusWire;
  limit?: number;
}): Promise<ApiResult<StatementsResponse>> {
  const params = new URLSearchParams();
  if (query.file_id) params.set('file_id', query.file_id);
  if (query.status) params.set('status', query.status);
  if (query.limit) params.set('limit', String(query.limit));
  const qs = params.toString();
  return toResult<StatementsResponse>(
    await requestJson(`/api/v1/statements${qs ? `?${qs}` : ''}`)
  );
}

/** 拍板回写（恒 202，端点永不 409）——轮询 /jobs/{job_id} 至终态，
 *  report.writeback.cas_ok=false 表示文件已被外部修改、拍板已存为草案 */
export async function postDecisionResolve(
  statementId: string,
  body: DecisionResolveRequest
): Promise<ApiResult<DecisionResolveAccepted>> {
  return toResult<DecisionResolveAccepted>(
    await requestJsonPost(
      `/api/v1/decisions/${encodeURIComponent(statementId)}/resolve`,
      body
    )
  );
}


/** 草案列表（分页） */
export async function fetchRevisionProposals(query: {
  status?: string;
  cursor?: string | null;
  limit?: number;
}): Promise<ApiResult<RevisionProposalPage>> {
  const params = new URLSearchParams();
  if (query.status) params.set('status', query.status);
  if (query.cursor) params.set('cursor', query.cursor);
  if (query.limit) params.set('limit', String(query.limit));
  const qs = params.toString();
  return toResult<RevisionProposalPage>(
    await requestJson(`/api/v1/revision-proposals${qs ? `?${qs}` : ''}`)
  );
}

/** 外部智能体修订草案提交（恒 202；conflict=受理初判预览，
 *  权威结果在 job report.proposal） */
export async function postRevisionProposal(
  body: RevisionProposalRequest
): Promise<ApiResult<RevisionProposalAccepted>> {
  return toResult<RevisionProposalAccepted>(
    await requestJsonPost('/api/v1/revision-proposals', body)
  );
}

/** 采纳草案（202；report.adopt.cas_ok=false=CAS 冲突不落版） */
export async function postRevisionProposalAdopt(draftId: string): Promise<ApiResult<JobAccepted>> {
  return toResult<JobAccepted>(
    await requestJsonPost(
      `/api/v1/revision-proposals/${encodeURIComponent(draftId)}/adopt`,
      {}
    )
  );
}

/** 获取单条草案的多模态 Diff 审阅载荷（基准版/磁盘现态/草案快照，只读绝不写盘） */
export async function fetchRevisionProposalContent(
  draftId: string
): Promise<ApiResult<RevisionProposalContentResponse>> {
  return toResult<RevisionProposalContentResponse>(
    await requestJson(`/api/v1/revision-proposals/${encodeURIComponent(draftId)}/content`)
  );
}

/** 驳回草案 / 退回重做（202，可选 reason） */
export async function postRevisionProposalDismiss(
  draftId: string,
  reason?: string
): Promise<ApiResult<JobAccepted>> {
  const cleanReason = reason?.trim();
  return toResult<JobAccepted>(
    await requestJsonPost(
      `/api/v1/revision-proposals/${encodeURIComponent(draftId)}/dismiss`,
      cleanReason ? { reason: cleanReason } : {}
    )
  );
}


/** 五槽位任务节点（专项详情下拉的数据源；suspended_on_hitl 高亮） */
export async function fetchInitiativeTasks(
  initiativeId: string
): Promise<ApiResult<InitiativeTasksResponse>> {
  return toResult<InitiativeTasksResponse>(
    await requestJson(`/api/v1/initiatives/${encodeURIComponent(initiativeId)}/tasks`)
  );
}

/** Checkpoint 同步受理：201 成功返回 {checkpoint_id, node_state}；
 *  校验失败 404 NOT_FOUND（不落库不推进，调用方直接重试/修正）；
 *  写线程积压 → 503 INDEX_BUSY。无 job_id。 */
export async function postCheckpoint(
  body: CheckpointCommitRequest
): Promise<ApiResult<CheckpointCommitResult>> {
  return toResult<CheckpointCommitResult>(
    await requestJsonPost('/api/v1/checkpoints', body)
  );
}

/** Checkpoint 查询（恢复=取节点最新 SUCCESS） */
export async function fetchCheckpoints(query: {
  initiative_id?: string;
  node_id?: string;
  status?: string;
  limit?: number;
}): Promise<ApiResult<CheckpointsPage>> {
  const params = new URLSearchParams();
  if (query.initiative_id) params.set('initiative_id', query.initiative_id);
  if (query.node_id) params.set('node_id', query.node_id);
  if (query.status) params.set('status', query.status);
  if (query.limit) params.set('limit', String(query.limit));
  const qs = params.toString();
  return toResult<CheckpointsPage>(
    await requestJson(`/api/v1/checkpoints${qs ? `?${qs}` : ''}`)
  );
}


/** 专项归档（202；非 Delivered 态归档在 report.warn='当前非已交付态'） */
export async function postInitiativeArchive(
  initiativeId: string,
  body: { note?: string } = {}
): Promise<ApiResult<InitiativeJobAccepted>> {
  return toResult<InitiativeJobAccepted>(
    await requestJsonPost(`/api/v1/initiatives/${encodeURIComponent(initiativeId)}/archive`, body)
  );
}

/** 专项重开（202；archived → 按 StateSignals 重算回退） */
export async function postInitiativeReopen(
  initiativeId: string
): Promise<ApiResult<InitiativeJobAccepted>> {
  return toResult<InitiativeJobAccepted>(
    await requestJsonPost(`/api/v1/initiatives/${encodeURIComponent(initiativeId)}/reopen`, {})
  );
}


/** 取消任务（queued 立即；running 协作式——写线程阶段间隙检查，
 *  事务提交点不可中断；已结束任务 409 CONFLICT） */
export async function postJobCancel(jobId: string): Promise<ApiResult<JobCancelResult>> {
  return toResult<JobCancelResult>(
    await requestJsonPost(`/api/v1/jobs/${encodeURIComponent(jobId)}/cancel`, {})
  );
}

/** 任务结果（强类型读取：diff → fetchJobResult<DiffResult>；
 *  分块大结果经 next_cursor 续页） */
export async function fetchJobResult<R = unknown>(
  jobId: string
): Promise<ApiResult<JobResultResponse<R>>> {
  return toResult<JobResultResponse<R>>(
    await requestJson(`/api/v1/jobs/${encodeURIComponent(jobId)}/result`)
  );
}


export async function postDiffJob(body: DiffJobRequest): Promise<ApiResult<JobAccepted>> {
  return toResult<JobAccepted>(await requestJsonPost('/api/v1/diff', body));
}

/**
 * 语义 Diff 全链：POST /diff 202 受理 → 轮询至终态 →
 * /jobs/{id}/result 取 DiffResult。任务 failed/无结果时 ok:false 如实返回
 * （DIFF_JOB_FAILED / DIFF_RESULT_EMPTY）——调用方诚实降级，不拿本地 diff 冒充语义摘要。
 */
export async function fetchDiffSummaryViaJob(
  body: DiffJobRequest,
  pollOpts: JobPollOptions = {}
): Promise<ApiResult<DiffResult>> {
  const accepted = await postDiffJob(body);
  if (!accepted.ok) return accepted;
  const settled = await pollJobUntilSettled(accepted.data.job_id, pollOpts);
  if (!settled.ok) return settled;
  if (settled.data.state !== 'completed') {
    return {
      ok: false,
      data: null,
      code: 'DIFF_JOB_FAILED',
      error: settled.data.error || '语义 Diff 任务失败',
    };
  }
  const result = await fetchJobResult<DiffResult>(accepted.data.job_id);
  if (!result.ok) return result;
  if (!result.data.result) {
    return {
      ok: false,
      data: null,
      code: 'DIFF_RESULT_EMPTY',
      error: '语义 Diff 任务完成但无结果载荷',
    };
  }
  return { ok: true, data: result.data.result as DiffResult, status: result.status };
}


/** 单文件 L4A 摘要（确定性本地摘要；summary=null 且 queued=true 表示已入队未完成） */
export async function fetchFileSummaryDetail(
  fileId: string
): Promise<ApiResult<FileSummaryDetailResponse>> {
  return toResult<FileSummaryDetailResponse>(
    await requestJson(`/api/v1/summary/${encodeURIComponent(fileId)}`)
  );
}

/** 查索引任务状态 */
export async function fetchIndexJobStatus(
  jobId: string
): Promise<ApiResult<IndexJobStatus>> {
  return toResult<IndexJobStatus>(
    await requestJson(`/api/v1/jobs/${encodeURIComponent(jobId)}`)
  );
}

export interface JobPollOptions {
  intervalMs?: number;
  maxAttempts?: number;
}

/**
 * 轮询任务至终态（completed/failed）。拍板/采纳/归档等 202 受理端点的标配后续
 * （受理即返回 202，权威结果在 job report）。
 * 传输/服务错误与终态都返回 ApiResult：ok=false 时带 code（含 JOB_POLL_TIMEOUT）；
 * state==='failed' 时仍返回 ok=true 的终态快照（调用方读 error 字段区分业务失败）。
 */
export async function pollJobUntilSettled(
  jobId: string,
  opts: JobPollOptions = {}
): Promise<ApiResult<IndexJobStatus>> {
  const intervalMs = opts.intervalMs ?? 900;
  const maxAttempts = opts.maxAttempts ?? 40;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const status = await fetchIndexJobStatus(jobId);
    if (!status.ok) return status;
    if (status.data.state === 'completed' || status.data.state === 'failed') {
      return status;
    }
    if (attempt < maxAttempts) {
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }
  return {
    ok: false,
    data: null,
    code: 'JOB_POLL_TIMEOUT',
    error: '任务轮询超时，请稍后在任务列表查看结果',
  };
}

/**
 * 从完成的任务状态中提取具名业务载荷分支（如 `writeback` / `adopt`）。
 *
 * 后端 Rust 服务将载荷放在 `job.result[branch]`；
 * 兼容测试桩直接将字段平铺在 `job.report` 或 `job.result` 的历史形状。
 */
export function extractJobBranch<T extends object>(
  job: IndexJobStatus,
  branch: string
): T | null {
  const isRecord = (v: unknown): v is Record<string, unknown> =>
    Boolean(v) && typeof v === 'object' && !Array.isArray(v);
  if (isRecord(job.result)) {
    const nested = job.result[branch];
    if (isRecord(nested)) return nested as T;
    if ('cas_ok' in job.result) return job.result as T;
  }
  if (isRecord(job.report)) {
    const nested = (job.report as unknown as Record<string, unknown>)[branch];
    if (isRecord(nested)) return nested as T;
    if ('cas_ok' in job.report) return job.report as T;
  }
  return null;
}

/** 查服务运行状态（含进行中的索引任务与数据时效） */
export async function fetchWorkspaceStatus(): Promise<ApiResult<WorkspaceStatusResponse>> {
  return toResult<WorkspaceStatusResponse>(await requestJson('/api/v1/status'));
}

/**
 * 有界检索：GET /api/v1/search。
 * CommandPalette 的全文通道（本地文件名命中即时刷新，服务端结果防抖后并入）。
 * q 为必填非空关键词（服务端 400）；format/dir 可选；limit 默认 30（clamp 1..100）。
 */
export async function fetchSearch(
  q: string,
  options: { format?: string; dir?: string; limit?: number } = {}
): Promise<ApiResult<SearchResponseDto>> {
  const params = new URLSearchParams();
  params.set('q', q);
  if (options.format) params.set('format', options.format);
  if (options.dir) params.set('dir', options.dir);
  if (options.limit) params.set('limit', String(options.limit));
  return toResult<SearchResponseDto>(
    await requestJson(`/api/v1/search?${params.toString()}`)
  );
}

/**
 * 跨项目联合检索：GET /api/v1/search/cross。
 * 主区 + 全部在线挂载参考工作区一次查完；挂载区命中带 source_workspace 来源标注，
 * 离线挂载在 mounts[] 中诚实降级（online=false + 最后已知摘要）。
 */
export async function fetchCrossSearch(
  q: string,
  options: { format?: string; dir?: string; limit?: number } = {}
): Promise<ApiResult<CrossSearchResponseDto>> {
  const params = new URLSearchParams();
  params.set('q', q);
  if (options.format) params.set('format', options.format);
  if (options.dir) params.set('dir', options.dir);
  if (options.limit) params.set('limit', String(options.limit));
  return toResult<CrossSearchResponseDto>(
    await requestJson(`/api/v1/search/cross?${params.toString()}`)
  );
}

/** GET /api/v1/mounts —— 挂载列表（在线现读摘要；离线给最后已知摘要 + error） */
export async function fetchMounts(): Promise<ApiResult<MountListResponseDto>> {
  return toResult<MountListResponseDto>(await requestJson('/api/v1/mounts'));
}

/** POST /api/v1/mounts —— 只读挂载参考工作区（父子互斥/重复挂载服务端确定性拒绝） */
export async function mountWorkspace(
  rootPath: string
): Promise<ApiResult<MountAcceptedDto>> {
  return toResult<MountAcceptedDto>(
    await requestJsonPost('/api/v1/mounts', { root_path: rootPath })
  );
}

/** DELETE /api/v1/mounts/{mount_id} —— 卸载（只断开只读连接，绝不动参考区磁盘） */
export async function unmountWorkspace(
  mountId: string
): Promise<ApiResult<{ ok: boolean; mount_id: string }>> {
  return toResult<{ ok: boolean; mount_id: string }>(
    await requestJsonDelete(`/api/v1/mounts/${encodeURIComponent(mountId)}`)
  );
}


/** 阶段一：POST /api/v1/capsules/preview —— 零副作用预览体积、敏感排除与 confirm token */
export async function previewCapsule(
  req: import('./apiTypes').CapsulePreviewRequest
): Promise<ApiResult<import('./apiTypes').CapsulePreviewResponse>> {
  return toResult<import('./apiTypes').CapsulePreviewResponse>(
    await requestJsonPost('/api/v1/capsules/preview', req)
  );
}

/** 阶段二：POST /api/v1/capsules/export —— 必须携带有效 preview_token + confirmed_preview=true */
export async function exportCapsule(
  req: import('./apiTypes').CapsuleExportRequest
): Promise<ApiResult<import('./apiTypes').CapsuleExportResponse>> {
  return toResult<import('./apiTypes').CapsuleExportResponse>(
    await requestJsonPost('/api/v1/capsules/export', req)
  );
}

/** POST /api/v1/capsules/inspect —— 秒开校验任意本地开放胶囊目录（识别 capsule-manifest.json） */
export async function inspectCapsuleDir(
  capsuleDir: string
): Promise<ApiResult<import('./apiTypes').CapsuleInspectResponse>> {
  return toResult<import('./apiTypes').CapsuleInspectResponse>(
    await requestJsonPost('/api/v1/capsules/inspect', { capsule_dir: capsuleDir })
  );
}

/** POST /api/v1/capsules/file —— 沙箱读取胶囊内附带快照原文（支持决定行号证据跳转） */
export async function readCapsuleFile(
  capsuleDir: string,
  bundledRelPath: string
): Promise<ApiResult<import('./apiTypes').CapsuleFileContentResponse>> {
  return toResult<import('./apiTypes').CapsuleFileContentResponse>(
    await requestJsonPost('/api/v1/capsules/file', {
      capsule_dir: capsuleDir,
      bundled_rel_path: bundledRelPath,
    })
  );
}


/** GET /api/v1/storage/integrity —— 校验全部活跃快照 SHA-256 并诚实报告受损影响范围 */
export async function verifyStorageIntegrity(): Promise<
  ApiResult<import('./apiTypes').BlobIntegrityReport>
> {
  return toResult<import('./apiTypes').BlobIntegrityReport>(
    await requestJson('/api/v1/storage/integrity')
  );
}

/** POST /api/v1/storage/gc —— 存储瘦身预演或执行（保护决定/因果边证据快照） */
export async function runStorageGc(
  req: import('./apiTypes').StorageGcRequest
): Promise<ApiResult<import('./apiTypes').StorageGcResponse>> {
  return toResult<import('./apiTypes').StorageGcResponse>(
    await requestJsonPost('/api/v1/storage/gc', req)
  );
}

/** POST /api/v1/export/workspace —— 零锁定工作区全量开放导出 */
export async function exportWorkspaceOpenArchive(
  req: import('./apiTypes').WorkspaceOpenExportRequest
): Promise<ApiResult<import('./apiTypes').WorkspaceOpenExportResponse>> {
  return toResult<import('./apiTypes').WorkspaceOpenExportResponse>(
    await requestJsonPost('/api/v1/export/workspace', req)
  );
}

/** POST /api/v1/storage/diagnostic-zip —— 落盘生成脱敏运行诊断包 ZIP */
export async function exportDiagnosticZip(
  outputPath?: string | null
): Promise<ApiResult<import('./apiTypes').DiagnosticZipResponse>> {
  return toResult<import('./apiTypes').DiagnosticZipResponse>(
    await requestJsonPost('/api/v1/storage/diagnostic-zip', {
      output_path: outputPath ?? null,
    })
  );
}

/** 一键下载脱敏诊断包 ZIP 地址（浏览器/WebView 直下 `guanlan-diagnostic.zip`） */
export function diagnosticZipDownloadUrl(): string {
  return resolveApiUrl('/api/v1/storage/diagnostic-zip');
}


/** GET /api/v1/folders —— 获取工作区全部真实目录（含空文件夹） */
export async function fetchWorkspaceFolders(): Promise<
  ApiResult<import('./apiTypes').FolderListResponseDto>
> {
  return toResult<import('./apiTypes').FolderListResponseDto>(await requestJson('/api/v1/folders'));
}

/** POST /api/v1/folders —— 在工作区新建真实文件夹 */
export async function postCreateFolder(
  parentDir: string,
  name: string
): Promise<ApiResult<import('./apiTypes').FolderMutationResponseDto>> {
  return toResult<import('./apiTypes').FolderMutationResponseDto>(
    await requestJsonPost('/api/v1/folders', { parent_dir: parentDir, name })
  );
}

/** POST /api/v1/folders/rename —— 重命名文件夹并保真更新子树所有 file_id */
export async function postRenameFolder(
  folderPath: string,
  newName: string
): Promise<ApiResult<import('./apiTypes').FolderMutationResponseDto>> {
  return toResult<import('./apiTypes').FolderMutationResponseDto>(
    await requestJsonPost('/api/v1/folders/rename', {
      folder_path: folderPath,
      new_name: newName,
    })
  );
}

/** POST /api/v1/folders/move —— 移动文件夹（防成环）并保真更新子树所有 file_id */
export async function postMoveFolder(
  folderPath: string,
  targetParentDir: string
): Promise<ApiResult<import('./apiTypes').FolderMutationResponseDto>> {
  return toResult<import('./apiTypes').FolderMutationResponseDto>(
    await requestJsonPost('/api/v1/folders/move', {
      folder_path: folderPath,
      target_parent_dir: targetParentDir,
    })
  );
}

/** POST /api/v1/folders/trash —— 将文件夹移入系统回收站（强制 confirm=true） */
export async function postTrashFolder(
  folderPath: string,
  confirm: boolean
): Promise<ApiResult<import('./apiTypes').FolderMutationResponseDto>> {
  return toResult<import('./apiTypes').FolderMutationResponseDto>(
    await requestJsonPost('/api/v1/folders/trash', {
      folder_path: folderPath,
      confirm,
    })
  );
}

/** POST /api/v1/files/create —— 在指定目录新建 Markdown 文档并立即入库 */
export async function postCreateDocument(
  targetDir: string,
  name: string,
  initialContent?: string
): Promise<ApiResult<import('./apiTypes').CreateDocumentResponseDto>> {
  return toResult<import('./apiTypes').CreateDocumentResponseDto>(
    await requestJsonPost('/api/v1/files/create', {
      target_dir: targetDir,
      name,
      ...(initialContent !== undefined ? { initial_content: initialContent } : {}),
    })
  );
}

/** POST /api/v1/files/batch-move —— 批量移动文件 */
export async function postBatchMoveFiles(
  fileIds: string[],
  targetDir: string
): Promise<ApiResult<import('./apiTypes').BatchFileMutationResponseDto>> {
  return toResult<import('./apiTypes').BatchFileMutationResponseDto>(
    await requestJsonPost('/api/v1/files/batch-move', {
      file_ids: fileIds,
      target_dir: targetDir,
    })
  );
}

/** POST /api/v1/files/batch-trash —— 批量移入系统回收站（强制 confirm=true） */
export async function postBatchTrashFiles(
  fileIds: string[],
  confirm: boolean
): Promise<ApiResult<import('./apiTypes').BatchFileMutationResponseDto>> {
  return toResult<import('./apiTypes').BatchFileMutationResponseDto>(
    await requestJsonPost('/api/v1/files/batch-trash', {
      file_ids: fileIds,
      confirm,
    })
  );
}

/** GET /api/v1/mounts/{mount_id}/files —— 读取只读挂载工作区的目录与文件树 */
export async function fetchMountedFiles(
  mountId: string,
  limit = 1000
): Promise<ApiResult<import('./apiTypes').MountedFilesResponseDto>> {
  return toResult<import('./apiTypes').MountedFilesResponseDto>(
    await requestJson(`/api/v1/mounts/${encodeURIComponent(mountId)}/files?limit=${limit}`)
  );
}


export async function fetchProjects(): Promise<
  ApiResult<import('./apiTypes').ProjectListResponseDto>
> {
  return toResult<import('./apiTypes').ProjectListResponseDto>(await requestJson('/api/v1/projects'));
}

export async function postAddProject(req: {
  root_path: string;
  name?: string;
  readonly?: boolean;
  activate?: boolean;
}): Promise<ApiResult<import('./apiTypes').ProjectMutationResponseDto>> {
  return toResult<import('./apiTypes').ProjectMutationResponseDto>(
    await requestJsonPost('/api/v1/projects', req)
  );
}

export async function patchProject(
  projectId: string,
  patch: { name?: string; readonly?: boolean }
): Promise<ApiResult<import('./apiTypes').ProjectMutationResponseDto>> {
  return toResult<import('./apiTypes').ProjectMutationResponseDto>(
    await requestJsonPatch(`/api/v1/projects/${encodeURIComponent(projectId)}`, patch)
  );
}

export async function deleteProject(
  projectId: string
): Promise<ApiResult<import('./apiTypes').ProjectListResponseDto>> {
  return toResult<import('./apiTypes').ProjectListResponseDto>(
    await requestJsonDelete(`/api/v1/projects/${encodeURIComponent(projectId)}`)
  );
}

export async function postActivateProject(
  projectId: string
): Promise<ApiResult<import('./apiTypes').ProjectMutationResponseDto>> {
  return toResult<import('./apiTypes').ProjectMutationResponseDto>(
    await requestJsonPost(`/api/v1/projects/${encodeURIComponent(projectId)}/activate`, {})
  );
}

export async function postRescanProject(
  projectId: string
): Promise<ApiResult<{ ok: boolean; project_id: string; job_id: string }>> {
  return toResult<{ ok: boolean; project_id: string; job_id: string }>(
    await requestJsonPost(`/api/v1/projects/${encodeURIComponent(projectId)}/rescan`, {})
  );
}

export async function fetchProjectTree(
  projectId: string,
  limit = 2000
): Promise<ApiResult<import('./apiTypes').ProjectTreeResponseDto>> {
  return toResult<import('./apiTypes').ProjectTreeResponseDto>(
    await requestJson(`/api/v1/projects/${encodeURIComponent(projectId)}/tree?limit=${limit}`)
  );
}

export async function fetchProjectsOverview(): Promise<
  ApiResult<import('./apiTypes').ProjectsOverviewResponseDto>
> {
  return toResult<import('./apiTypes').ProjectsOverviewResponseDto>(
    await requestJson('/api/v1/projects/overview')
  );
}

export async function fetchProjectsSearch(
  q: string,
  limit = 30
): Promise<ApiResult<import('./apiTypes').CrossProjectSearchResponseDto>> {
  const qs = new URLSearchParams({ q, limit: String(limit) });
  return toResult<import('./apiTypes').CrossProjectSearchResponseDto>(
    await requestJson(`/api/v1/projects/search?${qs.toString()}`)
  );
}

export async function postCreateFolderInProject(
  projectId: string,
  parentDir: string,
  name: string
): Promise<ApiResult<import('./apiTypes').FolderMutationResponseDto>> {
  return toResult<import('./apiTypes').FolderMutationResponseDto>(
    await requestJsonPost(`/api/v1/projects/${encodeURIComponent(projectId)}/folders`, {
      parent_dir: parentDir,
      name,
    })
  );
}

export async function postRenameFolderInProject(
  projectId: string,
  folderPath: string,
  newName: string
): Promise<ApiResult<import('./apiTypes').FolderMutationResponseDto>> {
  return toResult<import('./apiTypes').FolderMutationResponseDto>(
    await requestJsonPost(`/api/v1/projects/${encodeURIComponent(projectId)}/folders/rename`, {
      folder_path: folderPath,
      new_name: newName,
    })
  );
}

export async function postMoveFolderInProject(
  projectId: string,
  folderPath: string,
  targetParentDir: string
): Promise<ApiResult<import('./apiTypes').FolderMutationResponseDto>> {
  return toResult<import('./apiTypes').FolderMutationResponseDto>(
    await requestJsonPost(`/api/v1/projects/${encodeURIComponent(projectId)}/folders/move`, {
      folder_path: folderPath,
      target_parent_dir: targetParentDir,
    })
  );
}

export async function postTrashFolderInProject(
  projectId: string,
  folderPath: string,
  confirm: boolean
): Promise<ApiResult<import('./apiTypes').FolderMutationResponseDto>> {
  return toResult<import('./apiTypes').FolderMutationResponseDto>(
    await requestJsonPost(`/api/v1/projects/${encodeURIComponent(projectId)}/folders/trash`, {
      folder_path: folderPath,
      confirm,
    })
  );
}

export async function postCreateDocumentInProject(
  projectId: string,
  targetDir: string,
  name: string,
  initialContent?: string
): Promise<ApiResult<import('./apiTypes').CreateDocumentResponseDto>> {
  return toResult<import('./apiTypes').CreateDocumentResponseDto>(
    await requestJsonPost(`/api/v1/projects/${encodeURIComponent(projectId)}/files/create`, {
      target_dir: targetDir,
      name,
      ...(initialContent !== undefined ? { initial_content: initialContent } : {}),
    })
  );
}

export async function postMoveFileInProject(
  projectId: string,
  fileId: string,
  targetDir: string
): Promise<ApiResult<import('./apiTypes').FileMutationResponse>> {
  return toResult<import('./apiTypes').FileMutationResponse>(
    await requestJsonPost(
      `/api/v1/projects/${encodeURIComponent(projectId)}/files/${encodeURIComponent(fileId)}/move`,
      { target_dir: targetDir }
    )
  );
}


export async function fetchServerReadingStates(): Promise<
  ApiResult<import('./apiTypes').ReadingStateListResponseDto>
> {
  return toResult<import('./apiTypes').ReadingStateListResponseDto>(
    await requestJson('/api/v1/reading-state')
  );
}

export async function postBatchReadingState(
  req: import('./apiTypes').ReadingStateBatchRequestDto
): Promise<ApiResult<import('./apiTypes').ReadingStateBatchResponseDto>> {
  return toResult<import('./apiTypes').ReadingStateBatchResponseDto>(
    await requestJsonPost('/api/v1/reading-state/batch', req)
  );
}


