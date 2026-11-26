/** 全文件格式小写扩展名 token（既有的 'md' | 'svg' | 'pdf' 逐字保留，
 *  其余格式如 'ts' | 'png' | 'docx' | 'xlsx' | 'mp4' | 'zip' | 'bin' ...）。 */
export type FileFormat = string;

export type ContentRole =
  | '需求'
  | '方案'
  | '说明'
  | '交接'
  | '报告'
  | '决策'
  | '素材'
  | '其他';

export type ClassificationProvenance = '来自路径' | '来自正文' | '待核对';

export type CoverageKind =
  | 'full_text'
  | 'svg_text'
  | 'pdf_page_text'
  | 'office_structured'
  | 'filename_only'
  | 'unindexed';

export type PdfIndexStatus =
  | 'unindexed'
  | 'page_indexed'
  | 'extract_failed'
  | 'ocr_optional'
  | 'image_only'
  | 'ocr_pending'
  | 'encrypted'
  | 'corrupted'
  | 'metadata_only';

export interface MarkdownSection {
  id: string;
  title: string;
  level: 1 | 2 | 3;
  startLine: number;
  endLine: number;
  isExplicitCallout?: '核心结论' | '需你决策' | '推荐及理由' | '影响与等待范围';
  summaryText?: string;
}

export interface Revision {
  revision_id: string;
  file_id: string;
  versionNumber: number;
  content_sha256: string;
  observed_at: string;
  source_time?: string;
  commit_time?: string;
  author_hint?: string;
  agent_turn_hint?: string;
  sizeBytes: number;
  snapshotAvailable: boolean;
  isBaselineProtected?: boolean;
  markdownContent?: string;
  svgSource?: string;
  svgExtractedTexts?: string[];
  pdfPages?: {
    pageNumber: number;
    heading: string;
    extractedText: string;
    visualSummary: string;
  }[];
  changedSectionsFromPrev?: string[];
  summaryNote: string;
}

export interface FileRecord {
  file_id: string;
  relative_path: string;
  previous_paths?: string[];
  title: string;
  format: FileFormat;
  folder: string;
  role: ContentRole;
  roleProvenance: ClassificationProvenance;
  topics: { name: string; provenance: ClassificationProvenance; rule: string }[];
  current_revision_id: string;
  revisions: Revision[];
  coverage: CoverageKind;
  pdfStatus?: PdfIndexStatus;
  pdfStatusReason?: string;
  parseWarning?: string;
  brokenLinks?: string[];
}

export type TimelineEventKind =
  | 'discovered'
  | 'appeared'
  | 'modified'
  | 'missing'
  | 'moved_or_copied'
  | 'file_renamed'
  | 'file_moved'
  | 'file_trashed'
  | 'decision_changed'
  | 'decision_raised'
  | 'workspace_baseline'
  | 'read_error'
  | 'read_recovered';

export interface TimelineEvent {
  event_id: string;
  kind: TimelineEventKind;
  file_id: string;
  revision_id: string;
  prev_revision_id?: string;
  observed_at: string;
  source_time?: string;
  occurred_source?: string | null;
  occurred_precision?: string | null;
  commit_time?: string;
  batch_id?: string;
  batch_title?: string;
  topic_lane: string;
  task_code?: string;
  headline: string;
  detail: string;
  format?: string | null;
  changedSections?: string[];
  addedLines?: number;
  removedLines?: number;
  isRollback?: boolean;
  sameHashCandidatePaths?: string[];
  decision_id?: string;
  action?: string;
  time_basis?: string | null;
}

export type DecisionStatus =
  | '待确认'
  | '已确认'
  | '已否决'
  | '已搁置'
  | '已取代'
  | '来源不一致'
  | '未知';

export interface OfficeEvidenceAnchor {
  kind: 'xlsx_range' | 'docx_paragraph';
  sheet?: string;
  cellRange?: string;
  paragraph?: number;
  heading?: string;
}

/** PDF 页码证据锚点（`path.pdf#page=N`，1-based 精确页码） */
export interface PdfEvidenceAnchor {
  kind: 'pdf_page';
  page: number;
  heading?: string;
  excerpt?: string;
}

export interface DecisionSourceEvidence {
  source_id: string;
  file_id: string;
  revision_id: string;
  relative_path: string;
  lineStart: number;
  lineEnd: number;
  observed_at: string;
  source_time?: string;
  claimedStatus: DecisionStatus;
  exactQuote: string;
  confirmer?: string;
  note: string;
  officeAnchor?: OfficeEvidenceAnchor;
  pdfAnchor?: PdfEvidenceAnchor;
}

export interface DecisionAssertion {
  decision_id: string;
  code: string;
  namespace: string;
  question: string;
  status: DecisionStatus;
  isCandidateOnly: boolean;
  options: string[];
  recommendation: string;
  impactBlocked: string[];
  impactAllowed: string[];
  confirmationBasis?: {
    recordText: string;
    confirmer: string;
    confirmedAt: string;
    file_id: string;
    revision_id: string;
    lineRange: [number, number];
  };
  evidences: DecisionSourceEvidence[];
  conflictExplanation?: string;
  topic: string;
}

export type RelationType =
  | 'explicit_reference'
  | 'derived_from_context'
  | 'revision_evolution'
  | 'decision_basis'
  | 'same_topic_or_code'
  | 'inferred_candidate';

export interface RelationEdge {
  edge_id: string;
  source_id: string;
  target_id: string;
  type: RelationType;
  isInferred: boolean;
  label: string;
  reason: string;
  locator?: { startLine: number; endLine: number };
}

export interface ReadingState {
  file_id: string;
  last_read_revision_id?: string;
  last_section_id?: string;
  last_page_number?: number;
  scrollPercent: number;
  isFullyRead: boolean;
  bookmarked: boolean;
  personalNote?: string;
  updated_at: string;
  baselineOnly?: boolean;
}

export interface EvidencePointer {
  file_id: string;
  revision_id: string;
  relative_path: string;
  content_sha256: string;
  locator:
    | { kind: 'lines'; start: number; end: number }
    | { kind: 'svg_text'; fragment: string }
    | { kind: 'pdf_page'; page: number }
    | { kind: 'file' };
  evidence_kind: 'explicit_source' | 'decision_record' | 'svg_label' | 'metadata_only';
  index_generation: number;
  observed_at: string;
  coverage: CoverageKind;
  stale: boolean;
  excerpt: string;
  note?: string;
  granularity?: 'full' | 'summary' | 'diff_only' | 'metadata_only' | 'decisions_only';
  sizeBytes?: number;
}

export type McpToolName =
  | 'overview'
  | 'search'
  | 'read'
  | 'timeline'
  | 'diff'
  | 'decisions'
  | 'relations'
  | 'open_reader';

export type McpErrorCode =
  | 'OUT_OF_SCOPE'
  | 'NOT_FOUND'
  | 'REVISION_UNAVAILABLE'
  | 'INDEX_STALE'
  | 'ROOT_IN_USE'
  | 'UNSUPPORTED_CONTENT'
  | 'FILE_BUSY'
  | 'CONTENT_NOT_LOADED'
  | 'DIFF_TOO_LARGE';

export interface WorkspaceConfig {
  rootPath: string;
  rootKey: string;
  dataDirPath: string;
  excludedDirs: string[];
  disableGitIgnore: boolean;
  gitIgnoreWarning: string;
  enumSnapshot: {
    date: string;
    mdCount: number;
    svgCount: number;
    pdfCount: number;
    totalCount: number;
    indexedSuccessCount: number;
    parseFailedCount: number;
    pdfUnindexedCount: number;
  };
  quota: {
    maxTotalMiB: number;
    usedTotalMiB: number;
    maxSingleBinaryMiB: number;
    protectedSnapshotsCount: number;
    evictedSnapshotsCount: number;
  };
  runtimeStatus: {
    connectionMode: 'direct_stdio' | 'magpie_router';
    serviceState: 'monitoring' | 'reconciling' | 'disconnected';
    sseSeq: number;
    indexGeneration: number;
    activeAgents: string[];
    loopbackUrl: string;
  };
}
