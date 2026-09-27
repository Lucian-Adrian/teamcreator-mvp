export type EvidenceState =
  | 'supported'
  | 'not_found'
  | 'conflict'
  | 'derived_by_rule'
  | 'expert_observation';

export type ReviewState =
  | 'unreviewed'
  | 'manager_confirmed'
  | 'manager_corrected'
  | 'unresolved';

export type RecordKind = 'member' | 'task' | 'deliverable' | 'risk' | 'decision';
export type MemberType = 'person' | 'organization' | 'group' | 'role' | 'unknown';
export type ProposalStatus = 'proposed' | 'applied' | 'rejected';
export type JobStatus = 'queued' | 'running' | 'completed' | 'partial' | 'failed';

export interface SourceRef {
  source_id: string;
  location: string;
  quote: string;
}

/** Explicitly supplied collaboration information; never inferred from portraits or resumes. */
export interface CollaborationProfile {
  basis: 'declared' | 'provided_assessment';
  source_label: string;
  recorded_on: string | null;
  soft_skills: string[];
  working_preferences: string;
  psychometric_method: string | null;
  psychometric_summary: string | null;
  compatibility: Array<{ member_id: string; note: string }>;
}

export interface ProjectSource {
  id: string;
  name: string;
  relative_path?: string;
  duplicate_of?: string;
  sha256: string;
  size: number;
  media_type: string;
  parser_status: 'parsed' | 'unsupported' | 'failed' | 'empty';
  parsed_text_characters?: number;
  segments_total?: number;
  processed_segments?: number[];
  parse_coverage?: 'complete' | 'partial' | 'legacy_unknown';
  extraction_coverage?: 'pending' | 'partial' | 'complete' | 'legacy_unknown' | 'unavailable';
  coverage_note?: string;
  extraction_note?: string;
  fixture_only?: boolean;
  created_at: string;
  excerpt?: string;
  error?: string;
}

export interface ProjectRecord {
  id: string;
  kind: RecordKind;
  title: string;
  status: string | null;
  owner: string | null;
  owner_id?: string | null;
  due: string | null;
  due_basis?: 'reported' | 'baseline' | 'forecast' | 'unknown';
  completed_at?: string | null;
  baseline_due?: string | null;
  current_forecast?: string | null;
  depends_on: string[];
  dependency_refs?: Record<string, SourceRef[]>;
  unresolved_dependencies?: string[];
  source_refs: SourceRef[];
  field_refs?: Record<string, SourceRef[]>;
  evidence_state: EvidenceState;
  review_state: ReviewState;
  created_at: string;
  updated_at: string;
  description?: string | null;
  planned_start?: string | null;
  planned_duration_days?: number | null;
  effort_hours?: number | null;
  documented_skills?: string[];
  availability_note?: string | null;
  collaboration_profile?: CollaborationProfile | null;
  role?: string | null;
  member_type?: MemberType;
  /** UI-only portrait metadata. Synthetic fixture portraits are not extracted employee photos. */
  avatar_asset?: string;
  avatar_crop?: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';
  avatar_is_illustrative?: boolean;
  reason?: string | null;
}

export interface ProposalItem {
  id: string;
  operation: 'create' | 'update';
  record_kind: RecordKind;
  record_id: string | null;
  title: string;
  fields: Partial<ProjectRecord>;
  before: Partial<ProjectRecord> | null;
  source_refs: SourceRef[];
  consequential: boolean;
  review_state: ReviewState;
  conflict?: boolean;
  stale?: boolean;
}

export interface SourceConflict {
  field: string;
  record_title: string;
  claims: Array<{ value: string | null; source_refs: SourceRef[] }>;
}

export interface ProjectProposal {
  agent_request?: { key: string; fingerprint: string; based_on_version: string };
  id: string;
  project_id: string;
  title: string;
  summary: string;
  status: ProposalStatus;
  source_ids: string[];
  items: ProposalItem[];
  conflicts: SourceConflict[];
  missing_info: string[];
  provider_mode: 'model' | 'degraded';
  provider_model: string | null;
  created_at: string;
  decided_at?: string;
  decision_reason?: string;
}

export interface AuditEvent {
  id: string;
  project_id: string;
  type: 'source_added' | 'proposal_created' | 'proposal_applied' | 'proposal_rejected' | 'proposal_stale' | 'proposal_item_held' | 'proposal_item_merged' | 'record_edited' | 'record_created' | 'project_created' | 'extraction_retry' | 'extraction_failed';
  actor: string;
  at: string;
  summary: string;
  before?: unknown;
  after?: unknown;
  source_ids?: string[];
  proposal_id?: string;
  record_id?: string;
}

export interface ProjectChange {
  id: string;
  project_id: string;
  at: string;
  type: string;
  title: string;
  summary: string;
  source_refs: SourceRef[];
  review_state: ReviewState;
  proposal_id?: string;
}

export interface ProjectSummary {
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
  synthetic: boolean;
  description?: string;
}

export interface ProjectWorkspace {
  project: ProjectSummary;
  members: ProjectRecord[];
  tasks: ProjectRecord[];
  deliverables: ProjectRecord[];
  risks: ProjectRecord[];
  decisions: ProjectRecord[];
  dependencies: Array<{
    id: string;
    from_id: string;
    to_id: string;
    evidence_state: EvidenceState;
    source_refs: SourceRef[];
  }>;
  assignments: Array<{
    id: string;
    record_id: string;
    member_id: string;
    evidence_state: EvidenceState;
    source_refs: SourceRef[];
  }>;
  sources: ProjectSource[];
  proposals: ProjectProposal[];
  changes: ProjectChange[];
  audit: AuditEvent[];
  graph: {
    cycles: string[][];
    has_cycles: boolean;
  };
}

export interface ParsedFileResult {
  name: string;
  status: string;
  parser_status: ProjectSource['parser_status'];
  source_id?: string;
  error?: string;
  excerpt?: string;
  parsed_text_characters?: number;
  segments_total?: number;
  processed_segments?: number[];
  parse_coverage?: ProjectSource['parse_coverage'];
  extraction_coverage?: ProjectSource['extraction_coverage'];
  coverage_note?: string;
  extraction_note?: string;
  fixture_only?: boolean;
}

export interface ExtractionSummary {
  provider_mode: 'model' | 'degraded';
  provider_model: string | null;
  files: ParsedFileResult[];
  records_proposed: number;
  conflicts: number;
  missing_info: string[];
  coverage?: {
    segments_sent: number;
    total_segments: number;
    segments_remaining: number;
    complete: boolean;
    model_complete?: boolean;
    parser_complete?: boolean;
    parser_limited_sources?: number;
    budget_exhausted?: boolean;
    note?: string;
  };
  error?: string;
}

export interface SourceQuoteContext {
  source_id: string;
  location: string;
  excerpt: string;
  excerpt_start: number;
  total_characters: number;
  match_start: number | null;
  match_end: number | null;
  match_count: number;
  match_count_capped: boolean;
  exact_match: boolean;
  ambiguous: boolean;
  parse_coverage?: ProjectSource['parse_coverage'];
  extraction_coverage?: ProjectSource['extraction_coverage'];
  coverage_note?: string;
  extraction_note?: string;
}

export interface IngestResult {
  sources: ProjectSource[];
  extraction: ExtractionSummary;
  proposal: ProjectProposal | null;
}

export interface JobSnapshot<T = IngestResult> {
  id: string;
  project_id: string;
  kind: 'ingest' | 'checkin' | 'retry' | 'diagnosis';
  status: JobStatus;
  phase: string;
  progress: number;
  files_total?: number;
  files_processed?: number;
  files_parsed?: number;
  files_not_parsed?: number;
  segments_total?: number;
  segments_processed?: number;
  segments_remaining?: number;
  segment_budget?: number;
  event_sequence?: number;
  events?: JobEvent[];
  created_at: string;
  updated_at: string;
  result?: T;
  error?: string;
}

export interface JobEvent {
  sequence: number;
  at: string;
  type: 'queued' | 'phase' | 'progress' | 'source' | 'batch' | 'warning' | 'completed' | 'partial' | 'failed';
  phase: string;
  progress: number;
  message: string;
}

export interface ProviderStatus {
  provider: 'codex_cli' | 'none';
  status: 'verified' | 'installed' | 'unavailable';
  mode: 'model' | 'degraded';
  model: string | null;
  shell_tools: false;
  web_search: false;
  message: string;
  last_verified_at?: string;
  last_success_at?: string;
}

export interface ImpactPath {
  from_id: string;
  from_title: string;
  affected_id: string;
  affected_title: string;
  via: Array<{ id: string; title: string; relation: 'depends_on' }>;
  basis: 'derived_by_rule';
  explanation: string;
  source_refs: SourceRef[];
}

export interface DependencyGraphStatus {
  cycles: string[][];
  has_cycles: boolean;
}

export interface ProjectImpact {
  task_id: string;
  task_title: string;
  paths: ImpactPath[];
  graph: DependencyGraphStatus;
  warning?: string;
}
