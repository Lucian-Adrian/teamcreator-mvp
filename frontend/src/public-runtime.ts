import demoFixtureJson from './public-demo-fixture.json';
import type {
  AuditEvent, JobEvent, ProjectChange, ProjectProposal, ProjectRecord, ProjectSource,
  ProjectSummary, ProjectWorkspace, ProposalItem, RecordKind, SourceQuoteContext, SourceRef,
} from '../../shared/types';
import { reviewProposalItem } from '../../shared/proposal-review.js';
import { assertTaskDependencyAcyclic, findTaskDependencyCycle, normalizeSourceRefLocation } from '../../shared/dependency-validation.js';
import { collaborationProfileSchema, validateCollaborationReferences } from '../../shared/collaboration-profile.js';
import { deterministicCandidates, parseStructuredText, readPublicFile, type DeterministicCandidate, type ParsedPublicFile } from './public-parser';
import { PublicBrowserStore, type PublicBrowserState } from './public-store';

const MAX_FILES = 12;
const MAX_FILE_BYTES = 1 * 1024 * 1024;
const MAX_TOTAL_BYTES = 5 * 1024 * 1024;
const MAX_SNAPSHOT_CHARS = 48_000;
const demoFixture = demoFixtureJson as unknown as ProjectWorkspace;

export interface PublicAiStatus {
  configured: boolean;
  status: 'configured' | 'unavailable';
  model: string | null;
  message: string;
}

export interface PublicAiRequest {
  documents: Array<{ source_id: string; name: string; text: string }>;
  records: Array<{ id: string; kind: RecordKind; title: string; status: string | null; owner: string | null; due: string | null; depends_on: string[] }>;
  focus?: 'project' | 'diagnosis';
}

export interface PublicAiResult {
  items: Array<{
    record_kind: RecordKind;
    title: string;
    record_id: string | null;
    fields: Partial<ProjectRecord> & { depends_on_titles?: string[] };
    source_refs: SourceRef[];
  }>;
  missing_info: string[];
  provider_model: string;
  provider_mode: 'model';
}

export interface PublicRuntimeOptions {
  /** The host wires an explicit opt-in status and extraction request before installation. */
  ai?: {
    status: () => Promise<PublicAiStatus>;
    extract: (input: PublicAiRequest) => Promise<PublicAiResult>;
  };
}

interface PublicFileWork {
  source: ProjectSource;
  text: string;
  rows: ReturnType<typeof deterministicCandidates>;
  result: ParsedPublicFile;
}

export interface PublicRuntimeStore {
  readonly idPrefix: string;
  initialize(): Promise<void>;
  read<T>(read: (state: PublicBrowserState) => T): Promise<T>;
  transact<T>(change: (state: PublicBrowserState) => T): Promise<T>;
}

export type PublicApiHandler = (request: Request) => Promise<Response>;

interface ExtractionResult {
  provider_mode: 'model' | 'degraded';
  provider_model: string | null;
  files: Array<Record<string, unknown>>;
  records_proposed: number;
  conflicts: number;
  missing_info: string[];
  error?: string;
  coverage: { segments_sent: number; total_segments: number; segments_remaining: number; complete: boolean; model_complete: boolean; parser_complete: boolean; note: string };
}

class ApiError extends Error {
  constructor(readonly status: number, message: string) { super(message); this.name = 'PublicApiError'; }
}

function now(): string { return new Date().toISOString(); }
function uid(prefix: string): string { return `${prefix}-${crypto.randomUUID()}`; }
function clone<T>(value: T): T { return structuredClone(value); }
function allRecords(workspace: ProjectWorkspace): ProjectRecord[] {
  return [...workspace.members, ...workspace.tasks, ...workspace.deliverables, ...workspace.risks, ...workspace.decisions];
}
function recordArray(workspace: ProjectWorkspace, kind: RecordKind): ProjectRecord[] {
  if (kind === 'member') return workspace.members;
  if (kind === 'task') return workspace.tasks;
  if (kind === 'deliverable') return workspace.deliverables;
  if (kind === 'risk') return workspace.risks;
  return workspace.decisions;
}
function kindFromRoute(route: string): RecordKind | null {
  const kinds: Record<string, RecordKind> = { members: 'member', tasks: 'task', deliverables: 'deliverable', risks: 'risk', decisions: 'decision' };
  return kinds[route] || null;
}
function publicError(error: unknown): { status: number; body: { error: string } } {
  if (error instanceof ApiError) return { status: error.status, body: { error: error.message } };
  return { status: 500, body: { error: error instanceof Error ? error.message.slice(0, 500) : 'Public browser request failed.' } };
}

function emptyWorkspace(project: ProjectSummary): ProjectWorkspace {
  return { project, members: [], tasks: [], deliverables: [], risks: [], decisions: [], dependencies: [], assignments: [], sources: [], proposals: [], changes: [], audit: [], graph: { cycles: [], has_cycles: false } };
}

function addAudit(workspace: ProjectWorkspace, type: AuditEvent['type'], summary: string, extras: Partial<AuditEvent> = {}): void {
  workspace.audit.unshift({ id: uid('event'), project_id: workspace.project.id, type, actor: 'browser-local manager', at: now(), summary, ...extras });
  workspace.project.updated_at = now();
}

function addChange(workspace: ProjectWorkspace, type: string, title: string, summary: string, refs: SourceRef[] = [], review_state: ProjectChange['review_state'] = 'manager_confirmed', proposal_id?: string): void {
  workspace.changes.unshift({ id: uid('change'), project_id: workspace.project.id, at: now(), type, title, summary, source_refs: refs, review_state, proposal_id });
}

function refreshGraph(workspace: ProjectWorkspace): void {
  const records = allRecords(workspace);
  const byId = new Map(records.map((record) => [record.id, record]));
  workspace.dependencies = records.flatMap((record) => record.depends_on.filter((id) => byId.has(id)).map((dependencyId) => ({
    id: `${record.id}:${dependencyId}`, from_id: record.id, to_id: dependencyId,
    evidence_state: record.dependency_refs?.[dependencyId]?.length ? 'supported' as const : 'expert_observation' as const,
    source_refs: record.dependency_refs?.[dependencyId] || [],
  })));
  workspace.assignments = records.flatMap((record) => record.owner_id && byId.has(record.owner_id) && byId.get(record.owner_id)?.kind === 'member'
    ? [{ id: `${record.id}:${record.owner_id}`, record_id: record.id, member_id: record.owner_id, evidence_state: record.field_refs?.owner?.length ? 'supported' as const : 'derived_by_rule' as const, source_refs: record.field_refs?.owner || [] }]
    : []);
  const cycle = findTaskDependencyCycle(records);
  workspace.graph = { cycles: cycle ? [cycle] : [], has_cycles: !!cycle };
}

function remapRefs(refs: SourceRef[] | undefined, sourceIds: Map<string, string>): SourceRef[] {
  return (refs || []).map((ref) => ({ ...ref, source_id: sourceIds.get(ref.source_id) || ref.source_id }));
}

function fixtureWorkspace(prefix: string): { workspace: ProjectWorkspace; sourceTexts: Record<string, string> } {
  const workspace = clone(demoFixture);
  const timestamp = now();
  const oldProjectId = workspace.project.id;
  const sourceIds = new Map(workspace.sources.map((source) => [source.id, uid(`${prefix}-source`)]));
  const recordIds = new Map(allRecords(workspace).map((record) => [record.id, uid(`${prefix}-record`)]));
  const proposalIds = new Map(workspace.proposals.map((proposal) => [proposal.id, uid(`${prefix}-proposal`)]));
  workspace.project.id = uid(`${prefix}-project`);
  workspace.project.created_at = timestamp;
  workspace.project.updated_at = timestamp;
  workspace.sources = workspace.sources.map((source) => ({ ...source, id: sourceIds.get(source.id)!, created_at: timestamp }));
  for (const record of allRecords(workspace)) {
    const previousId = record.id;
    record.id = recordIds.get(previousId)!;
    record.owner_id = record.owner_id ? recordIds.get(record.owner_id) || null : null;
    record.depends_on = record.depends_on.map((dependencyId) => recordIds.get(dependencyId) || dependencyId);
    record.source_refs = remapRefs(record.source_refs, sourceIds);
    record.field_refs = Object.fromEntries(Object.entries(record.field_refs || {}).map(([key, refs]) => [key, remapRefs(refs, sourceIds)]));
    record.dependency_refs = Object.fromEntries(Object.entries(record.dependency_refs || {}).map(([key, refs]) => [recordIds.get(key) || key, remapRefs(refs, sourceIds)]));
    record.created_at = timestamp;
    record.updated_at = timestamp;
  }
  workspace.dependencies = workspace.dependencies.map((dependency) => ({
    ...dependency, id: uid(`${prefix}-edge`), from_id: recordIds.get(dependency.from_id) || dependency.from_id,
    to_id: recordIds.get(dependency.to_id) || dependency.to_id, source_refs: remapRefs(dependency.source_refs, sourceIds),
  }));
  workspace.assignments = workspace.assignments.map((assignment) => ({
    ...assignment, id: uid(`${prefix}-assignment`), record_id: recordIds.get(assignment.record_id) || assignment.record_id,
    member_id: recordIds.get(assignment.member_id) || assignment.member_id, source_refs: remapRefs(assignment.source_refs, sourceIds),
  }));
  workspace.proposals = workspace.proposals.map((proposal) => ({ ...proposal, id: proposalIds.get(proposal.id)!, project_id: workspace.project.id }));
  workspace.audit = workspace.audit.map((event) => ({
    ...event, id: uid(`${prefix}-event`), project_id: workspace.project.id,
    source_ids: event.source_ids?.map((sourceId) => sourceIds.get(sourceId) || sourceId),
    record_id: event.record_id ? recordIds.get(event.record_id) || event.record_id : undefined,
    proposal_id: event.proposal_id ? proposalIds.get(event.proposal_id) || event.proposal_id : undefined,
    at: timestamp,
  }));
  workspace.changes = workspace.changes.map((change) => ({
    ...change, id: uid(`${prefix}-change`), project_id: workspace.project.id, source_refs: remapRefs(change.source_refs, sourceIds),
    proposal_id: change.proposal_id ? proposalIds.get(change.proposal_id) || change.proposal_id : undefined, at: timestamp,
  }));
  workspace.graph = { cycles: [], has_cycles: false };
  refreshGraph(workspace);
  const sourceTexts = Object.fromEntries(workspace.sources.map((source) => [source.id, source.excerpt || '']));
  return { workspace, sourceTexts };
}

function createProject(prefix: string, name: string, synthetic = false): ProjectWorkspace {
  const timestamp = now();
  const project: ProjectSummary = { id: uid(`${prefix}-project`), name: name.trim(), created_at: timestamp, updated_at: timestamp, synthetic };
  const workspace = emptyWorkspace(project);
  addAudit(workspace, 'project_created', `Project created: ${project.name}`);
  addChange(workspace, 'project_created', project.name, 'Created in this browser.');
  return workspace;
}

async function hashBytes(file: File): Promise<string> {
  try {
    const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
    return [...new Uint8Array(digest)].map((part) => part.toString(16).padStart(2, '0')).join('');
  } catch { return ''; }
}

function safeRelativePath(path: string, fallback: string): string {
  const parts = path.replace(/\\/g, '/').split('/').filter((part) => part && part !== '.' && part !== '..').slice(-8);
  return parts.join('/') || fallback;
}

async function prepareFiles(files: File[], relativePaths: string[], prefix: string): Promise<PublicFileWork[]> {
  if (!files.length) throw new ApiError(400, 'Choose at least one file to upload.');
  if (files.length > MAX_FILES) throw new ApiError(413, `Choose no more than ${MAX_FILES} files at a time.`);
  if (files.some((file) => file.size > MAX_FILE_BYTES)) throw new ApiError(413, 'Public browser mode accepts files up to 1 MiB each.');
  if (files.reduce((total, file) => total + file.size, 0) > MAX_TOTAL_BYTES) throw new ApiError(413, 'This public import is larger than the 5 MiB browser limit. Split the files into smaller groups.');
  const prepared: PublicFileWork[] = [];
  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    const parsed = await readPublicFile(file);
    const sourceId = uid(`${prefix}-source`);
    const parsedTextCharacters = parsed.text.length;
    const source: ProjectSource = {
      id: sourceId,
      name: file.name.slice(0, 240),
      relative_path: safeRelativePath(relativePaths[index] || file.name, file.name),
      sha256: await hashBytes(file),
      size: file.size,
      media_type: parsed.mediaType,
      parser_status: parsed.parserStatus,
      parsed_text_characters: parsedTextCharacters,
      segments_total: Math.max(1, Math.ceil(parsedTextCharacters / 12_000)),
      processed_segments: [],
      parse_coverage: parsed.parseCoverage || (parsed.parserStatus === 'parsed' || parsed.parserStatus === 'empty' ? 'complete' : 'partial'),
      extraction_coverage: 'unavailable',
      coverage_note: parsed.parserStatus === 'unsupported' ? 'The browser saved the file name and fingerprint but cannot read this format.' : undefined,
      extraction_note: parsed.note,
      fixture_only: false,
      created_at: now(),
      excerpt: parsed.text ? parsed.text.slice(0, 2_500) : undefined,
      error: parsed.error,
    };
    prepared.push({ source, text: parsed.text, rows: deterministicCandidates(parsed.rows, sourceId), result: parsed });
  }
  return prepared;
}

function addProposal(workspace: ProjectWorkspace, items: ProposalItem[], sourceIds: string[], mode: 'model' | 'degraded', model: string | null, title: string): ProjectProposal | null {
  if (!items.length) return null;
  const proposal: ProjectProposal = {
    id: uid('proposal'), project_id: workspace.project.id, title, status: 'proposed',
    summary: `${items.length} source-cited change${items.length === 1 ? '' : 's'} await manager review.`,
    source_ids: [...new Set(sourceIds)], items, conflicts: [], missing_info: [], provider_mode: mode,
    provider_model: model, created_at: now(),
  };
  workspace.proposals.unshift(proposal);
  addAudit(workspace, 'proposal_created', `Prepared ${items.length} pending source-cited changes.`, { source_ids: proposal.source_ids, proposal_id: proposal.id });
  addChange(workspace, 'proposal_created', title, proposal.summary, items.flatMap((item) => item.source_refs), 'unreviewed', proposal.id);
  return proposal;
}

function proposalItemsFromDeterministic(candidates: DeterministicCandidate[]): ProposalItem[] {
  return candidates.map((candidate) => ({
    id: uid('proposal-item'), operation: 'create', record_kind: candidate.kind, record_id: null,
    title: candidate.title, fields: candidate.fields, before: null, source_refs: candidate.source_refs,
    consequential: true, review_state: 'unreviewed',
  }));
}

function publicExtraction(files: PublicFileWork[], itemsCount: number, mode: 'model' | 'degraded' = 'degraded', model: string | null = null, error?: string, missingInfo: string[] = []): ExtractionResult {
  return {
    provider_mode: mode, provider_model: model,
    files: files.map(({ source, result }) => ({
      name: source.name,
      status: result.parserStatus === 'parsed' ? 'Parsed in browser' : result.parserStatus,
      parser_status: source.parser_status,
      source_id: source.id,
      excerpt: source.excerpt,
      parsed_text_characters: source.parsed_text_characters,
      segments_total: source.segments_total,
      processed_segments: source.processed_segments,
      parse_coverage: source.parse_coverage,
      extraction_coverage: source.extraction_coverage,
      coverage_note: source.coverage_note,
      extraction_note: source.extraction_note,
      error: source.error,
      fixture_only: source.fixture_only,
    })),
    records_proposed: itemsCount, conflicts: 0,
    missing_info: missingInfo,
    error,
    coverage: {
      segments_sent: mode === 'model' ? files.reduce((total, item) => total + (item.text ? 1 : 0), 0) : 0,
      total_segments: files.reduce((total, item) => total + (item.text ? Math.max(1, Math.ceil(item.text.length / 12_000)) : 0), 0),
      segments_remaining: 0, complete: mode === 'model' && files.every((item) => ['parsed', 'empty'].includes(item.source.parser_status)),
      model_complete: mode === 'model', parser_complete: files.every((item) => ['parsed', 'empty'].includes(item.source.parser_status)),
      note: mode === 'model' ? 'Optional provider returned a response; exact quotes are checked again in this browser.' : 'No model ran. Only recognized table rows can create deterministic source-cited proposals.',
    },
  };
}

function exactSourceRef(ref: SourceRef, sourceTexts: Record<string, string>, allowedSourceIds: Set<string>): SourceRef | null {
  if (!ref || typeof ref.source_id !== 'string' || !allowedSourceIds.has(ref.source_id)) return null;
  const quote = typeof ref.quote === 'string' ? ref.quote.trim() : '';
  const location = typeof ref.location === 'string' ? ref.location.slice(0, 500) : '';
  const text = sourceTexts[ref.source_id];
  if (quote.length < 4 || quote.length > 2_048 || !text?.includes(quote)) return null;
  return normalizeSourceRefLocation(text, { source_id: ref.source_id, location, quote });
}

function aiProposalItems(result: PublicAiResult, workspace: ProjectWorkspace, sourceTexts: Record<string, string>, allowedSourceIds: Set<string>): ProposalItem[] {
  if (!result || result.provider_mode !== 'model' || !Array.isArray(result.items)) throw new Error('AI response did not match the expected extraction contract.');
  if (result.items.length > 200) throw new Error('AI response exceeded the 200 change limit.');
  const records = allRecords(workspace).filter((record) => ['manager_confirmed', 'manager_corrected'].includes(record.review_state));
  const normalized = (value: string) => value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();
  const items: ProposalItem[] = [];
  for (const sourceItem of result.items) {
    if (!sourceItem || !['member', 'task', 'deliverable', 'risk', 'decision'].includes(sourceItem.record_kind) || typeof sourceItem.title !== 'string' || !sourceItem.title.trim() || sourceItem.title.length > 240) continue;
    const sourceRefs = Array.isArray(sourceItem.source_refs)
      ? sourceItem.source_refs.map((ref) => exactSourceRef(ref, sourceTexts, allowedSourceIds)).filter((ref): ref is SourceRef => !!ref)
      : [];
    if (!sourceRefs.length) continue;
    const rawFields = (sourceItem.fields || {}) as Record<string, unknown>;
    // A model may not create or revise psychosocial collaboration profiles. Those values require explicit human or assessment input.
    if ('collaboration_profile' in rawFields) continue;
    const fieldLimits: Record<string, number> = { status: 120, owner: 160, due: 80, completed_at: 80, baseline_due: 80, current_forecast: 80, description: 4_000, role: 160 };
    const fields = {} as Partial<ProjectRecord> & { depends_on_titles?: string[] };
    let malformedField = false;
    for (const [key, limit] of Object.entries(fieldLimits)) {
      if (rawFields[key] === undefined) continue;
      const value = rawFields[key];
      if (value !== null && (typeof value !== 'string' || value.length > limit)) { malformedField = true; break; }
      (fields as Record<string, unknown>)[key] = value;
    }
    if (rawFields.member_type !== undefined) {
      if (!['person', 'organization', 'group', 'role', 'unknown'].includes(String(rawFields.member_type))) malformedField = true;
      else fields.member_type = rawFields.member_type as ProjectRecord['member_type'];
    }
    if (rawFields.planned_start !== undefined) {
      const value = rawFields.planned_start;
      if (value !== null && !isIsoCalendarDate(value)) malformedField = true;
      else fields.planned_start = value as string | null;
    }
    for (const key of ['planned_duration_days', 'effort_hours'] as const) {
      if (rawFields[key] === undefined) continue;
      const value = rawFields[key];
      if (value !== null && (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100_000)) malformedField = true;
      else (fields as Record<string, unknown>)[key] = value;
    }
    if (rawFields.documented_skills !== undefined) {
      const value = rawFields.documented_skills;
      if (!Array.isArray(value) || value.length > 16 || value.some((skill) => typeof skill !== 'string' || !skill.trim() || skill.trim().length > 80)) malformedField = true;
      else fields.documented_skills = (value as string[]).map((skill) => skill.trim());
    }
    if (rawFields.availability_note !== undefined) {
      const value = rawFields.availability_note;
      if (value !== null && (typeof value !== 'string' || value.length > 2_000)) malformedField = true;
      else fields.availability_note = value as string | null;
    }
    const relatedByTitle = Array.isArray(rawFields.depends_on_titles) && rawFields.depends_on_titles.every((value) => typeof value === 'string' && value.length <= 240)
      ? rawFields.depends_on_titles as string[] : [];
    if (rawFields.depends_on_titles !== undefined && !Array.isArray(rawFields.depends_on_titles)) malformedField = true;
    if (malformedField) continue;
    let operation: ProposalItem['operation'] = 'create';
    let recordId: string | null = null;
    let before: Partial<ProjectRecord> | null = null;
    if (sourceItem.record_id) {
      const current = records.find((record) => record.id === sourceItem.record_id && record.kind === sourceItem.record_kind);
      if (!current) continue;
      operation = 'update'; recordId = current.id; before = clone(current);
    }
    const dependsOn = relatedByTitle.map((title) => records.find((record) => normalized(record.title) === normalized(String(title)))?.id).filter((id): id is string => !!id);
    const unknownDependencies = relatedByTitle.filter((title) => !records.some((record) => normalized(record.title) === normalized(String(title)))).map(String);
    if (dependsOn.length) fields.depends_on = dependsOn;
    else if (unknownDependencies.length) fields.depends_on = [];
    if (unknownDependencies.length) fields.unresolved_dependencies = unknownDependencies;
    fields.source_refs = sourceRefs;
    // Item citations are preserved as item-level evidence; the model did not emit per-field citations.
    delete fields.field_refs;
    fields.evidence_state = 'supported';
    fields.review_state = 'unreviewed';
    const sourceTitle = sourceItem.title.trim();
    items.push({
      id: uid('proposal-item'), operation, record_kind: sourceItem.record_kind, record_id: recordId,
      title: sourceTitle, fields, before, source_refs: sourceRefs, consequential: true, review_state: 'unreviewed',
    });
  }
  return items;
}

function sourceQuoteContext(text: string, quote: string, location: string): SourceQuoteContext {
  const occurrences: number[] = [];
  let from = 0;
  while (occurrences.length < 101) {
    const found = text.indexOf(quote, from);
    if (found < 0) break;
    occurrences.push(found); from = found + Math.max(1, quote.length);
  }
  const lineNumber = Number(location.match(/line\s+(\d+)/i)?.[1]);
  let selected = occurrences[0];
  if (lineNumber > 0 && occurrences.length > 1) {
    selected = occurrences.reduce((best, position) => {
      const targetLine = text.slice(0, position).split('\n').length;
      return Math.abs(targetLine - lineNumber) < Math.abs(text.slice(0, best).split('\n').length - lineNumber) ? position : best;
    }, selected);
  }
  const start = Math.max(0, (selected ?? 0) - 320);
  const end = Math.min(text.length, (selected ?? 0) + quote.length + 480);
  return {
    source_id: '', location, excerpt: text.slice(start, end), excerpt_start: start, total_characters: text.length,
    match_start: selected ?? null, match_end: selected === undefined ? null : selected + quote.length,
    match_count: Math.min(occurrences.length, 100), match_count_capped: occurrences.length > 100,
    exact_match: occurrences.length > 0, ambiguous: occurrences.length > 1 && !(lineNumber > 0),
  };
}

function encodeJson(value: unknown, status = 200, headers: HeadersInit = {}): Response {
  const outputHeaders = new Headers(headers);
  outputHeaders.set('Content-Type', 'application/json; charset=utf-8');
  return new Response(JSON.stringify(value), { status, headers: outputHeaders });
}

function filenameBase(name: string): string {
  return name.normalize('NFKD').replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'project';
}

function exportWorkspace(workspace: ProjectWorkspace, sourceTexts: Record<string, string>, format: string): Response {
  if (format !== 'json' && format !== 'markdown') throw new ApiError(400, 'Choose json or markdown export format.');
  const base = filenameBase(workspace.project.name);
  if (format === 'json') {
    const projectSourceIds = new Set(workspace.sources.map((source) => source.id));
    const projectTexts = Object.fromEntries(Object.entries(sourceTexts).filter(([sourceId]) => projectSourceIds.has(sourceId)));
    const snapshot = { schema: 'teamcreator-public-snapshot/v1', source_texts_complete: true, exported_at: now(), workspace, source_texts: projectTexts };
    return new Response(JSON.stringify(snapshot, null, 2), {
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': `attachment; filename="${base}.json"` },
    });
  }
  const lines = [
    `# ${workspace.project.name}`, '',
    '> Exported from the public browser app. Browser-local source text is not included in this Markdown file.', '',
    '## Accepted records', '',
  ];
  for (const [kind, records] of [['People', workspace.members], ['Tasks', workspace.tasks], ['Deliverables', workspace.deliverables], ['Risks', workspace.risks], ['Decisions', workspace.decisions]] as Array<[string, ProjectRecord[]]>) {
    lines.push(`### ${kind}`, '');
    if (!records.length) lines.push('_No records._', '');
    for (const record of records) lines.push(`- **${record.title}**${record.status ? ` · ${record.status}` : ''}${record.owner ? ` · ${record.owner}` : ''}${record.due ? ` · ${record.due}` : ''}`);
    lines.push('');
  }
  lines.push('## Pending proposals', '');
  const pending = workspace.proposals.filter((proposal) => proposal.status === 'proposed');
  if (!pending.length) lines.push('_No pending proposals._', '');
  for (const proposal of pending) {
    lines.push(`### ${proposal.title}`, '', proposal.summary, '');
    for (const item of proposal.items) lines.push(`- ${item.record_kind}: ${item.title} (${item.review_state})`);
    lines.push('');
  }
  lines.push('## Sources', '');
  for (const source of workspace.sources) lines.push(`- ${source.name} · ${source.parser_status} · ${source.sha256 || 'fingerprint unavailable'}${source.extraction_note ? ` · ${source.extraction_note}` : ''}`);
  return new Response(lines.join('\n'), { headers: { 'Content-Type': 'text/markdown; charset=utf-8', 'Content-Disposition': `attachment; filename="${base}.md"` } });
}

function isObject(value: unknown): value is Record<string, any> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isIsoCalendarDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function validateSupplementalRecordFields(value: unknown, kind: RecordKind, members: readonly ProjectRecord[], ownId?: string): Partial<ProjectRecord> {
  if (!isObject(value)) return {};
  const result: Partial<ProjectRecord> = {};
  if ('planned_start' in value) {
    if (value.planned_start !== null && !isIsoCalendarDate(value.planned_start)) throw new Error('planned_start must be an ISO calendar date (YYYY-MM-DD) or null.');
    result.planned_start = value.planned_start as string | null;
  }
  for (const key of ['planned_duration_days', 'effort_hours'] as const) {
    if (!(key in value)) continue;
    const numeric = value[key];
    if (numeric !== null && (typeof numeric !== 'number' || !Number.isFinite(numeric) || numeric < 0 || numeric > 100_000)) throw new Error(`${key} must be a finite number between 0 and 100000 or null.`);
    result[key] = numeric as number | null;
  }
  if ('documented_skills' in value) {
    const skills = value.documented_skills;
    if (!Array.isArray(skills) || skills.length > 16 || skills.some((skill) => typeof skill !== 'string' || !skill.trim() || skill.trim().length > 80)) throw new Error('documented_skills must contain up to 16 non-empty strings of at most 80 characters.');
    result.documented_skills = (skills as string[]).map((skill) => skill.trim());
  }
  if ('availability_note' in value) {
    const note = value.availability_note;
    if (note !== null && (typeof note !== 'string' || note.length > 2_000)) throw new Error('availability_note must be a string up to 2000 characters or null.');
    result.availability_note = note as string | null;
  }
  if ('collaboration_profile' in value) {
    const rawProfile = value.collaboration_profile;
    if (kind !== 'member') throw new Error('collaboration_profile is only supported for member records.');
    if (rawProfile === null) result.collaboration_profile = null;
    else {
      const parsed = collaborationProfileSchema.safeParse(rawProfile);
      if (!parsed.success) throw new Error('collaboration_profile does not match the supported source-based profile shape.');
      try { validateCollaborationReferences(parsed.data, members, ownId); }
      catch (error) { throw new Error(error instanceof Error ? error.message : 'collaboration_profile contains an invalid member reference.'); }
      result.collaboration_profile = parsed.data;
    }
  }
  return result;
}

function validateSnapshot(value: unknown, prefix: string): { workspace: ProjectWorkspace; sourceTexts: Record<string, string> } {
  if (!isObject(value) || value.schema !== 'teamcreator-public-snapshot/v1' || !isObject(value.workspace) || !isObject(value.source_texts)) {
    throw new ApiError(400, 'This file is not a supported TeamCreator public snapshot (expected schema v1).');
  }
  const incoming = value.workspace as unknown as ProjectWorkspace;
  const arrayFields: Array<keyof ProjectWorkspace> = ['members', 'tasks', 'deliverables', 'risks', 'decisions', 'sources', 'proposals', 'changes', 'audit'];
  if (!isObject(incoming.project) || typeof incoming.project.name !== 'string' || !incoming.project.name.trim() || incoming.project.name.length > 150
    || arrayFields.some((field) => !Array.isArray(incoming[field]))) {
    throw new ApiError(400, 'The snapshot is missing required project lists or has an invalid project name.');
  }
  const recordKinds: Array<[keyof ProjectWorkspace, RecordKind]> = [
    ['members', 'member'], ['tasks', 'task'], ['deliverables', 'deliverable'], ['risks', 'risk'], ['decisions', 'decision'],
  ];
  if (recordKinds.some(([field, kind]) => (incoming[field] as unknown[]).some((record) => !isObject(record) || typeof record.id !== 'string' || typeof record.title !== 'string' || record.kind !== kind))
    || incoming.sources.some((source) => !isObject(source) || typeof source.id !== 'string' || typeof source.name !== 'string')
    || incoming.proposals.some((proposal) => !isObject(proposal) || typeof proposal.id !== 'string' || !Array.isArray(proposal.items)
      || proposal.items.some((item) => !isObject(item) || typeof item.id !== 'string' || typeof item.title !== 'string' || !isObject(item.fields)))) {
    throw new ApiError(400, 'Snapshot records, sources, or proposals have an invalid structure.');
  }
  const sourceTexts = value.source_texts as Record<string, string>;
  const sourceTextsComplete = value.source_texts_complete !== false;
  if (Object.values(sourceTexts).some((text) => typeof text !== 'string') || Object.values(sourceTexts).reduce((total, text) => total + text.length, 0) > 5_000_000) {
    throw new ApiError(413, 'Snapshot source text exceeds the 5,000,000 character public import limit.');
  }
  const records = allRecords(incoming);
  const proposalItemCount = incoming.proposals.reduce((total, proposal) => total + proposal.items.length, 0);
  if (incoming.sources.length > 500 || records.length > 5_000 || incoming.proposals.length > 500 || proposalItemCount > 5_000) {
    throw new ApiError(413, 'Snapshot exceeds the public import limits: 500 sources, 5,000 records or proposal items.');
  }
  const knownSourceIds = new Set(incoming.sources.map((source) => source.id));
  const unique = (items: string[]) => new Set(items).size === items.length && items.every(Boolean);
  if (!unique(incoming.sources.map((source) => source.id)) || !unique(records.map((record) => record.id))
    || !unique(incoming.proposals.map((proposal) => proposal.id)) || incoming.proposals.some((proposal) => !unique(proposal.items.map((item) => item.id)))) {
    throw new ApiError(400, 'Snapshot contains duplicate or empty project identifiers.');
  }
  try {
    for (const record of records) validateSupplementalRecordFields(record, record.kind, incoming.members, record.id);
    for (const proposal of incoming.proposals) for (const item of proposal.items) {
      validateSupplementalRecordFields(item.fields, item.record_kind, incoming.members, item.record_id || undefined);
      if (item.before) validateSupplementalRecordFields(item.before, item.record_kind, incoming.members, item.record_id || undefined);
    }
  } catch (error) {
    throw new ApiError(422, error instanceof Error ? error.message : 'Snapshot contains invalid collaboration or planning fields.');
  }
  const sourceTextFor = (sourceId: string): string | undefined => Object.prototype.hasOwnProperty.call(sourceTexts, sourceId) && typeof sourceTexts[sourceId] === 'string' ? sourceTexts[sourceId] : undefined;
  const checkRefs = (refs: SourceRef[] | undefined) => {
    for (const ref of refs || []) {
      if (!isObject(ref)) throw new ApiError(422, 'Snapshot contains a malformed source citation.');
      const quote = typeof ref?.quote === 'string' ? ref.quote.trim() : '';
      const text = typeof ref?.source_id === 'string' ? sourceTextFor(ref.source_id) : undefined;
      if (!knownSourceIds.has(ref.source_id) || quote.length < 4 || quote.length > 2_048
        || (text !== undefined && !normalizeSourceRefLocation(text, { source_id: ref.source_id, location: String(ref.location || ''), quote }))
        || (sourceTextsComplete && !text)) {
        throw new ApiError(422, 'Snapshot contains a source citation that cannot be verified against its saved text.');
      }
    }
  };
  for (const record of records) {
    checkRefs(record.source_refs);
    for (const refs of Object.values(record.field_refs || {})) checkRefs(refs);
    for (const refs of Object.values(record.dependency_refs || {})) checkRefs(refs);
  }
  for (const proposal of incoming.proposals) for (const item of proposal.items) {
    checkRefs(item.source_refs);
    checkRefs(item.fields.source_refs);
    for (const refs of Object.values(item.fields.field_refs || {})) checkRefs(refs);
  }
  for (const change of incoming.changes) checkRefs(change.source_refs);

  const workspace = clone(incoming);
  const sourceIds = new Map(workspace.sources.map((source) => [source.id, uid(`${prefix}-source`)]));
  const sourcesWithoutText = new Set([...sourceIds].filter(([sourceId]) => sourceTextFor(sourceId) === undefined).map(([, remappedId]) => remappedId));
  const recordIds = new Map(allRecords(workspace).map((record) => [record.id, uid(`${prefix}-record`)]));
  const proposalIds = new Map(workspace.proposals.map((proposal) => [proposal.id, uid(`${prefix}-proposal`)]));
  const remapCitation = (ref: SourceRef): SourceRef => {
    const originalText = sourceTextFor(ref.source_id);
    const normalized = originalText ? normalizeSourceRefLocation(originalText, ref) : ref;
    if (!normalized) throw new ApiError(422, 'Snapshot contains a source citation that cannot be verified against its saved text.');
    return { ...normalized, source_id: sourceIds.get(ref.source_id) || ref.source_id };
  };
  const remapCitations = (refs: SourceRef[] | undefined): SourceRef[] => (refs || []).map(remapCitation);
  const remapRecordFields = (value: Partial<ProjectRecord>): Partial<ProjectRecord> => ({
    ...value,
    id: value.id ? recordIds.get(value.id) || value.id : undefined,
    owner_id: value.owner_id ? recordIds.get(value.owner_id) || null : value.owner_id,
    depends_on: value.depends_on?.map((id) => recordIds.get(id) || id),
    collaboration_profile: value.collaboration_profile ? {
      ...value.collaboration_profile,
      compatibility: value.collaboration_profile.compatibility.map((entry) => ({ ...entry, member_id: recordIds.get(entry.member_id) || entry.member_id })),
    } : value.collaboration_profile,
    source_refs: remapCitations(value.source_refs),
    field_refs: Object.fromEntries(Object.entries(value.field_refs || {}).map(([key, refs]) => [key, remapCitations(refs)])),
    dependency_refs: Object.fromEntries(Object.entries(value.dependency_refs || {}).map(([key, refs]) => [recordIds.get(key) || key, remapCitations(refs)])),
  });
  const remapHistoryValue = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(remapHistoryValue);
    if (!isObject(value)) return value;
    if ('kind' in value && 'title' in value && 'source_refs' in value) return remapRecordFields(value as Partial<ProjectRecord>);
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (key === 'source_id' && typeof item === 'string') result[key] = sourceIds.get(item) || item;
      else if (key === 'source_ids' && Array.isArray(item)) result[key] = item.map((id) => sourceIds.get(String(id)) || id);
      else if (key === 'record_id' && typeof item === 'string') result[key] = recordIds.get(item) || item;
      else if (key === 'proposal_id' && typeof item === 'string') result[key] = proposalIds.get(item) || item;
      else if (key === 'project_id' && typeof item === 'string') result[key] = workspace.project.id;
      else result[key] = remapHistoryValue(item);
    }
    return result;
  };
  const oldProjectId = workspace.project.id;
  workspace.project.id = uid(`${prefix}-project`);
  workspace.sources = workspace.sources.map((source) => ({ ...source, id: sourceIds.get(source.id)! }));
  for (const source of workspace.sources) if (sourcesWithoutText.has(source.id)) {
    source.coverage_note = [source.coverage_note, 'Snapshot metadata retained this source citation but did not include text for opening its source window.'].filter(Boolean).join(' ');
    source.extraction_coverage = 'unavailable';
    source.extraction_note = 'No source text was included in this imported snapshot; quoted references are retained as historical metadata.';
    source.error = 'The original parsed source text was not included in the snapshot.';
  }
  for (const kind of ['members', 'tasks', 'deliverables', 'risks', 'decisions'] as const) {
    workspace[kind] = workspace[kind].map((record) => remapRecordFields(record) as ProjectRecord);
  }
  workspace.proposals = workspace.proposals.map((proposal) => ({
    ...proposal, id: proposalIds.get(proposal.id)!, project_id: workspace.project.id,
    source_ids: proposal.source_ids.map((id) => sourceIds.get(id) || id),
    items: proposal.items.map((item) => ({
      ...item, id: uid(`${prefix}-proposal-item`), record_id: item.record_id ? recordIds.get(item.record_id) || item.record_id : null,
      fields: remapRecordFields(item.fields), before: item.before ? remapRecordFields(item.before) : null,
      source_refs: remapCitations(item.source_refs),
    })),
  }));
  workspace.audit = workspace.audit.map((event) => ({
    ...event, id: uid(`${prefix}-event`), project_id: workspace.project.id,
    source_ids: event.source_ids?.map((id) => sourceIds.get(id) || id),
    record_id: event.record_id ? recordIds.get(event.record_id) || event.record_id : undefined,
    proposal_id: event.proposal_id ? proposalIds.get(event.proposal_id) || event.proposal_id : undefined,
    before: remapHistoryValue(event.before), after: remapHistoryValue(event.after),
  }));
  workspace.changes = workspace.changes.map((change) => ({
    ...change, id: uid(`${prefix}-change`), project_id: workspace.project.id,
    proposal_id: change.proposal_id ? proposalIds.get(change.proposal_id) || change.proposal_id : undefined,
    source_refs: remapCitations(change.source_refs),
  }));
  refreshGraph(workspace);
  const remappedText: Record<string, string> = {};
  for (const [sourceId, text] of Object.entries(sourceTexts)) if (sourceIds.has(sourceId)) remappedText[sourceIds.get(sourceId)!] = text;
  workspace.project.description = [workspace.project.description, 'Imported from a verified public browser snapshot.'].filter(Boolean).join(' ');
  if (oldProjectId === workspace.project.id) throw new ApiError(500, 'Snapshot project identifiers could not be remapped.');
  return { workspace, sourceTexts: remappedText };
}

function impactFor(workspace: ProjectWorkspace, taskId: string) {
  const records = allRecords(workspace);
  const target = records.find((record) => record.id === taskId);
  if (!target || !['task', 'deliverable'].includes(target.kind)) throw new ApiError(404, 'Task or deliverable not found.');
  const edges = new Map<string, string[]>();
  for (const record of records) for (const dependency of record.depends_on) edges.set(dependency, [...(edges.get(dependency) || []), record.id]);
  const paths: Array<{ from_id: string; from_title: string; affected_id: string; affected_title: string; via: Array<{ id: string; title: string; relation: 'depends_on' }>; basis: 'derived_by_rule'; explanation: string; source_refs: SourceRef[] }> = [];
  const walk = (fromId: string, chain: string[], seen: Set<string>) => {
    for (const nextId of edges.get(fromId) || []) {
      if (seen.has(nextId)) continue;
      const next = records.find((record) => record.id === nextId);
      if (!next) continue;
      const nextChain = [...chain, nextId];
      paths.push({ from_id: target.id, from_title: target.title, affected_id: next.id, affected_title: next.title,
        via: nextChain.map((id) => ({ id, title: records.find((record) => record.id === id)?.title || id, relation: 'depends_on' as const })),
        basis: 'derived_by_rule', explanation: 'Affected by a recorded dependency path.', source_refs: next.source_refs });
      walk(nextId, nextChain, new Set([...seen, nextId]));
    }
  };
  walk(target.id, [], new Set([target.id]));
  return { task_id: target.id, task_title: target.title, paths, graph: workspace.graph, warning: workspace.graph.has_cycles ? 'The dependency graph contains a cycle.' : undefined };
}

async function providerSnapshot(options: PublicRuntimeOptions): Promise<Record<string, unknown>> {
  if (!options.ai) return {
    provider: 'none', status: 'unavailable', mode: 'degraded', model: null, shell_tools: false, web_search: false,
    ai_configured: false,
    message: 'Public browser mode has no AI provider. Imports stay in this browser; recognized structured tables can create cited proposals.',
  };
  try {
    const status = await options.ai.status();
    return {
      provider: 'none', status: status.configured ? 'installed' : 'unavailable', mode: status.configured ? 'model' : 'degraded',
      model: status.model, shell_tools: false, web_search: false, ai_configured: status.configured,
      message: status.configured ? `${status.message} AI sharing runs only after you enable it.` : status.message,
    };
  } catch {
    return { provider: 'none', status: 'unavailable', mode: 'degraded', model: null, shell_tools: false, web_search: false, ai_configured: false,
      message: 'The optional public AI status check failed. Source storage and deterministic table parsing remain available.' };
  }
}

async function aiItemsFor(
  options: PublicRuntimeOptions, request: Request, workspace: ProjectWorkspace, sources: ProjectSource[], sourceTexts: Record<string, string>, focus: 'project' | 'diagnosis',
): Promise<{ items: ProposalItem[]; result: PublicAiResult | null; sourceIds: string[]; error?: string }> {
  if (request.headers.get('X-TeamCreator-AI') !== '1') return { items: [], result: null, sourceIds: [] };
  if (!options.ai) return { items: [], result: null, sourceIds: [], error: 'AI sharing was enabled, but no public AI provider is configured. Sources remain saved locally.' };
  const docs = sources.filter((source) => source.parser_status === 'parsed' && sourceTexts[source.id])
    .slice(0, MAX_FILES).map((source) => ({ source_id: source.id, name: source.name, text: sourceTexts[source.id] }));
  const totalCharacters = docs.reduce((total, document) => total + document.text.length, 0);
  if (!docs.length) return { items: [], result: null, sourceIds: [], error: 'No readable text was available for the optional AI provider.' };
  if (totalCharacters > MAX_SNAPSHOT_CHARS) return { items: [], result: null, sourceIds: [], error: 'AI sharing is capped at 48,000 characters per request. The sources remain saved locally.' };
  const records = allRecords(workspace).filter((record) => ['manager_confirmed', 'manager_corrected'].includes(record.review_state)).slice(0, 120).map((record) => ({
    id: record.id, kind: record.kind, title: record.title, status: record.status, owner: record.owner, due: record.due,
    depends_on: record.depends_on,
  }));
  try {
    const result = await options.ai.extract({ documents: docs, records, focus });
    const items = aiProposalItems(result, workspace, sourceTexts, new Set(docs.map((document) => document.source_id)));
    const validatedResult = {
      ...result,
      provider_model: typeof result.provider_model === 'string' ? result.provider_model : 'provider model not reported',
      missing_info: Array.isArray(result.missing_info) ? result.missing_info.filter((item) => typeof item === 'string').slice(0, 100) : [],
    } as PublicAiResult;
    if (result.items.length > items.length) validatedResult.missing_info.push(`${result.items.length - items.length} returned proposal item${result.items.length - items.length === 1 ? ' failed' : 's failed'} local field or exact-quote validation and was omitted.`);
    return { items, result: validatedResult, sourceIds: docs.map((document) => document.source_id) };
  } catch (error) {
    return { items: [], result: null, sourceIds: docs.map((document) => document.source_id), error: `Optional AI extraction failed: ${error instanceof Error ? error.message : 'unknown provider error'}. Sources remain saved locally.` };
  }
}

async function updateSourceExtractionStatus(
  store: PublicRuntimeStore, workspaceId: string, sourceIds: string[], mode: 'model' | 'degraded',
  error: string | undefined, prepared: PublicFileWork[], sourceTexts: Record<string, string>,
): Promise<void> {
  const allowed = new Set(sourceIds);
  const rowCounts = new Map(prepared.map((file) => [file.source.id, file.rows.length]));
  await store.transact((state) => {
    const workspace = state.workspaces.find((item) => item.project.id === workspaceId);
    if (!workspace) throw new ApiError(404, 'Project not found.');
    for (const source of workspace.sources) {
      if (allowed.has(source.id) && mode === 'model' && !error) {
        source.extraction_coverage = 'complete';
        source.processed_segments = Array.from({ length: Math.max(1, Math.ceil((source.parsed_text_characters || 0) / 12_000)) }, (_value, index) => index);
        source.extraction_note = 'Optional AI provider completed this source review. The browser rechecked every proposal quote before saving it.';
      } else if (allowed.has(source.id)) {
        source.extraction_coverage = 'unavailable';
        source.processed_segments = [];
        const localCount = rowCounts.get(source.id) || 0;
        const savedText = sourceTexts[source.id] || '';
        source.extraction_note = error
          ? `${error} No AI result was saved.`
          : localCount
            ? `No model ran. Deterministic browser rules mapped ${localCount} structured row${localCount === 1 ? '' : 's'} into pending cited proposals.`
            : savedText
              ? 'No model ran. Text is saved in this browser; plain prose is not converted into proposed facts.'
              : source.extraction_note || 'No model ran; this source format is unavailable in public browser mode.';
      }
    }
  });
  const updated = await store.read((state) => state.workspaces.find((item) => item.project.id === workspaceId)?.sources || []);
  const byId = new Map(updated.map((source) => [source.id, source]));
  for (const file of prepared) Object.assign(file.source, byId.get(file.source.id) || {});
}

async function processPreparedSources(
  store: PublicRuntimeStore, workspaceId: string, prepared: PublicFileWork[], options: PublicRuntimeOptions, request: Request, focus: 'project' | 'diagnosis' = 'project',
) {
  const key = request.headers.get('Idempotency-Key')?.trim();
  if (!key || key.length > 200) throw new ApiError(400, 'A valid Idempotency-Key is required for this import.');
  const fingerprint = JSON.stringify(prepared.map(({ source, text }) => ({ name: source.name, relative_path: source.relative_path, size: source.size, sha256: source.sha256, text_length: text.length })));
  const receiptId = `${workspaceId}:${key}`;
  const existing = await store.transact((state) => {
    const receipt = state.requestReceipts[receiptId];
    if (receipt) {
      if (receipt.fingerprint !== fingerprint) throw new ApiError(409, 'This Idempotency-Key was already used with different source content.');
      if (receipt.state === 'complete') return clone(receipt.response);
      throw new ApiError(409, 'This import is already being processed in this browser.');
    }
    state.requestReceipts[receiptId] = { fingerprint, state: 'processing' };
    const entries = Object.keys(state.requestReceipts);
    if (entries.length > 120) for (const oldKey of entries.slice(0, entries.length - 120)) delete state.requestReceipts[oldKey];
    return null;
  });
  if (existing) return existing;
  try {
  const saved = await store.transact((state) => {
    const workspace = state.workspaces.find((item) => item.project.id === workspaceId);
    if (!workspace) throw new ApiError(404, 'Project not found.');
    const existingCharacters = workspace.sources.reduce((total, source) => total + (state.sourceTexts[source.id]?.length || 0), 0);
    const incomingCharacters = prepared.reduce((total, file) => total + file.text.length, 0);
    if (existingCharacters + incomingCharacters > 5_000_000) throw new ApiError(413, 'This project has reached the 5,000,000 character public source-text limit. Export a snapshot or start a separate project.');
    for (const file of prepared) {
      workspace.sources.push(file.source);
      state.sourceTexts[file.source.id] = file.text;
      addAudit(workspace, 'source_added', `Added browser-local source: ${file.source.name}`, { source_ids: [file.source.id] });
    }
    addChange(workspace, 'source_added', `${prepared.length} source${prepared.length === 1 ? '' : 's'} added`, 'Source files were processed in this browser.');
    return clone(workspace);
  });
  const stateSnapshot = await store.read((state) => state);
  let proposalItems: ProposalItem[] = [];
  let mode: 'model' | 'degraded' = 'degraded';
  let model: string | null = null;
  let missingInfo: string[] = [];
  let error: string | undefined;
  let reviewedSourceIds: string[] = [];
  if (request.headers.get('X-TeamCreator-AI') === '1') {
    const ai = await aiItemsFor(options, request, saved, prepared.map((item) => item.source), stateSnapshot.sourceTexts, focus);
    proposalItems = ai.items; error = ai.error; reviewedSourceIds = ai.sourceIds;
    if (ai.result) { mode = 'model'; model = ai.result.provider_model; missingInfo = ai.result.missing_info || []; }
  } else {
    proposalItems = proposalItemsFromDeterministic(prepared.flatMap((item) => item.rows));
    reviewedSourceIds = prepared.map((item) => item.source.id);
  }
  await updateSourceExtractionStatus(store, workspaceId, reviewedSourceIds, mode, error, prepared, stateSnapshot.sourceTexts);
  let proposal: ProjectProposal | null = null;
  const selectedIds = prepared.map((file) => file.source.id);
  if (proposalItems.length) {
    proposal = await store.transact((state) => {
      const workspace = state.workspaces.find((item) => item.project.id === workspaceId);
      if (!workspace) throw new ApiError(404, 'Project not found.');
      return addProposal(workspace, proposalItems, selectedIds, mode, model, mode === 'model' ? 'AI proposals for manager review' : 'Structured table proposals for review');
    });
  }
  const sources = await store.read((state) => {
    const workspace = state.workspaces.find((item) => item.project.id === workspaceId);
    if (!workspace) throw new ApiError(404, 'Project not found.');
    return workspace.sources.filter((source) => selectedIds.includes(source.id));
  });
  const extraction = publicExtraction(prepared, proposalItems.length, mode, model, error, missingInfo);
  if (error) extraction.error = error;
  const response = { sources, extraction, proposal };
  await store.transact((state) => { state.requestReceipts[receiptId] = { fingerprint, state: 'complete', response }; });
  return response;
  } catch (error) {
    await store.transact((state) => { delete state.requestReceipts[receiptId]; }).catch(() => undefined);
    throw error;
  }
}

function textUpload(text: string, filename: string): File {
  return new File([text], filename, { type: 'text/plain' });
}

function safeJSON(request: Request): Promise<any> {
  return request.json().catch(() => { throw new ApiError(400, 'Request body must contain valid JSON.'); });
}

async function safeJSONBounded(request: Request, maxCharacters: number): Promise<any> {
  let text: string;
  try { text = await request.text(); } catch { throw new ApiError(400, 'Request body could not be read.'); }
  if (text.length > maxCharacters) throw new ApiError(413, `JSON request is limited to ${maxCharacters.toLocaleString()} characters.`);
  try { return JSON.parse(text); } catch { throw new ApiError(400, 'Request body must contain valid JSON.'); }
}

async function handlePublicRequest(request: Request, store: PublicRuntimeStore, options: PublicRuntimeOptions, nativeFetch: typeof fetch): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname.startsWith('/api/ai/')) return nativeFetch(request);
  if (!url.pathname.startsWith('/api/')) return nativeFetch(request);
  const segments = url.pathname.slice('/api/'.length).split('/').filter(Boolean).map((segment) => decodeURIComponent(segment));
  const method = request.method.toUpperCase();
  if (segments[0] === 'health' && method === 'GET') return encodeJson({ status: 'ok', api: 'public-browser', provider: await providerSnapshot(options) });
  if (segments[0] === 'provider' && method === 'GET') return encodeJson(await providerSnapshot(options));
  if (segments[0] === 'projects' && segments.length === 1 && method === 'GET') {
    const projects = await store.read((state) => state.workspaces.map((workspace) => workspace.project).sort((a, b) => b.updated_at.localeCompare(a.updated_at)));
    return encodeJson({ projects });
  }
  if (segments[0] === 'projects' && segments.length === 1 && method === 'POST') {
    const body = await safeJSON(request);
    if (typeof body?.name !== 'string' || !body.name.trim() || body.name.trim().length > 150) throw new ApiError(400, 'Enter a project name up to 150 characters.');
    const workspace = createProject(store.idPrefix, body.name.trim());
    await store.transact((state) => { state.workspaces.unshift(workspace); });
    return encodeJson({ project: workspace.project }, 201);
  }
  if (segments[0] === 'projects' && segments[1] === 'import' && segments.length === 2 && method === 'POST') {
    const body = await safeJSONBounded(request, 8_000_000);
    const snapshot = isObject(body) && 'snapshot' in body ? body.snapshot : body;
    const imported = validateSnapshot(snapshot, store.idPrefix);
    addAudit(imported.workspace, 'project_created', `Imported public snapshot: ${imported.workspace.project.name}`, { source_ids: imported.workspace.sources.map((source) => source.id) });
    addChange(imported.workspace, 'snapshot_imported', imported.workspace.project.name, 'Imported from a versioned public browser snapshot.');
    await store.transact((state) => {
      state.workspaces.unshift(imported.workspace);
      Object.assign(state.sourceTexts, imported.sourceTexts);
    });
    return encodeJson({ project: imported.workspace.project }, 201);
  }
  if (segments[0] === 'projects' && segments[1] === 'demo' && segments.length === 2 && method === 'POST') {
    const created = fixtureWorkspace(store.idPrefix);
    await store.transact((state) => { state.workspaces.unshift(created.workspace); Object.assign(state.sourceTexts, created.sourceTexts); });
    return encodeJson({ project: created.workspace.project }, 201);
  }
  if (segments[0] === 'projects' && segments[1] === 'demo-ai' && segments.length === 2 && method === 'POST') {
    const workspace = createProject(store.idPrefix, 'Iluminat stradal · laborator de surse sintetice', true);
    workspace.project.description = 'Demonstrație sintetică în browser. Sursele rămân pe acest dispozitiv; niciun model nu rulează fără activarea partajării AI.';
    await store.transact((state) => { state.workspaces.unshift(workspace); });
    return encodeJson({ project: workspace.project }, 201);
  }
  if (segments[0] !== 'projects' || !segments[1]) throw new ApiError(404, 'Public API route not found.');
  const projectId = segments[1];
  const workspaceRead = () => store.read((state) => state.workspaces.find((item) => item.project.id === projectId));
  if (segments.length === 3 && segments[2] === 'workspace' && method === 'GET') {
    const workspace = await workspaceRead();
    if (!workspace) throw new ApiError(404, 'Project not found.');
    return encodeJson(workspace);
  }
  if (segments.length === 3 && segments[2] === 'export' && method === 'GET') {
    const state = await store.read((value) => value);
    const workspace = state.workspaces.find((item) => item.project.id === projectId);
    if (!workspace) throw new ApiError(404, 'Project not found.');
    return exportWorkspace(workspace, state.sourceTexts, url.searchParams.get('format') || 'json');
  }
  if (segments.length === 3 && segments[2] === 'events' && method === 'GET') {
    const workspace = await workspaceRead();
    if (!workspace) throw new ApiError(404, 'Project not found.');
    const limit = Number(url.searchParams.get('limit') || 100);
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new ApiError(400, 'Event page size must be between 1 and 200.');
    const events = [
      ...workspace.audit.map((item) => ({ ...item, event_kind: 'audit' as const })),
      ...workspace.changes.map((item) => ({ ...item, event_kind: 'change' as const })),
    ].sort((left, right) => left.at.localeCompare(right.at) || left.id.localeCompare(right.id));
    const cursor = url.searchParams.get('after') || '';
    let start = 0;
    if (cursor) { const cursorIndex = events.findIndex((event) => event.id === cursor); if (cursorIndex < 0) throw new ApiError(410, 'The event cursor is outside the retained project history.'); start = cursorIndex + 1; }
    const page = events.slice(start, start + limit);
    return encodeJson({ events: page, next_cursor: page.at(-1)?.id || cursor || null, has_more: start + page.length < events.length });
  }
  if (segments.length === 5 && segments[2] === 'sources' && segments[4] === 'quote' && method === 'GET') {
    const state = await store.read((value) => value);
    const workspace = state.workspaces.find((item) => item.project.id === projectId);
    const sourceId = segments[3];
    const source = workspace?.sources.find((item) => item.id === sourceId);
    if (!workspace) throw new ApiError(404, 'Project not found.');
    if (!source) throw new ApiError(404, 'Source not found in this project.');
    const quote = (url.searchParams.get('quote') || '').trim();
    const location = (url.searchParams.get('location') || '').slice(0, 500);
    if (quote.length < 4 || quote.length > 2_048) throw new ApiError(400, 'Provide an exact source quote between 4 and 2,048 characters.');
    const text = state.sourceTexts[sourceId];
    if (text === undefined) throw new ApiError(422, 'Parsed source text is unavailable.');
    const normalized = normalizeSourceRefLocation(text, { source_id: sourceId, location, quote });
    const context = sourceQuoteContext(text, quote, normalized?.location || location);
    return encodeJson({ ...context, source_id: source.id, location: normalized?.location || location, parse_coverage: source.parse_coverage, extraction_coverage: source.extraction_coverage, coverage_note: source.coverage_note, extraction_note: source.extraction_note });
  }
  if (segments.length >= 4 && segments[2] === 'jobs' && method === 'GET') throw new ApiError(404, 'No asynchronous public browser job was created.');
  if (segments.length === 3 && segments[2] === 'ingest' && method === 'POST') {
    const form = await request.formData();
    const files = form.getAll('files').filter((value): value is File => value instanceof File);
    const relativePaths = form.getAll('relative_paths').map((value) => String(value));
    const prepared = await prepareFiles(files, relativePaths, store.idPrefix);
    const result = await processPreparedSources(store, projectId, prepared, options, request);
    return encodeJson(result, 201);
  }
  if (segments.length === 3 && segments[2] === 'checkins' && method === 'POST') {
    const body = await safeJSON(request);
    const text = typeof body?.text === 'string' ? body.text.trim() : '';
    if (!text || text.length > 80_000) throw new ApiError(400, 'Add update text under 80,000 characters.');
    const name = typeof body.sourceName === 'string' && body.sourceName.trim() ? body.sourceName.trim().slice(0, 160) : `Check-in ${now().slice(0, 10)}.txt`;
    const prepared = await prepareFiles([textUpload(text, name)], [name], store.idPrefix);
    const result = await processPreparedSources(store, projectId, prepared, options, request);
    return encodeJson(result, 201);
  }
  if (segments.length === 4 && segments[2] === 'sources' && segments[3] === 'retry' && method === 'POST') {
    const body = await safeJSON(request);
    const state = await store.read((value) => value);
    const workspace = state.workspaces.find((item) => item.project.id === projectId);
    if (!workspace) throw new ApiError(404, 'Project not found.');
    const wanted = Array.isArray(body.sourceIds) ? new Set(body.sourceIds.map(String)) : null;
    const sources = workspace.sources.filter((source) => !wanted || wanted.has(source.id));
    const prepared = sources.map((source): PublicFileWork => {
      const text = state.sourceTexts[source.id] || '';
      const result: ParsedPublicFile = {
        text, parserStatus: source.parser_status, mediaType: source.media_type, rows: [],
        note: source.extraction_note || 'No AI extraction ran in public browser mode.', error: source.error,
      };
      return { source, text, result, rows: deterministicCandidates(parseStructuredTextSafe(text, source.name), source.id) };
    });
    let proposal: ProjectProposal | null = null;
    let proposalItems: ProposalItem[] = [];
    let extractionError: string | undefined;
    let providerModel: string | null = null;
    let providerMode: 'model' | 'degraded' = 'degraded';
    let missingInfo: string[] = [];
    if (request.headers.get('X-TeamCreator-AI') === '1') {
      const ai = await aiItemsFor(options, request, workspace, sources, state.sourceTexts, 'project');
      proposalItems = ai.items; extractionError = ai.error;
      await updateSourceExtractionStatus(store, projectId, ai.sourceIds, ai.result ? 'model' : 'degraded', ai.error, prepared, state.sourceTexts);
      if (ai.result) { providerModel = ai.result.provider_model; providerMode = 'model'; missingInfo = ai.result.missing_info || []; }
    } else {
      proposalItems = proposalItemsFromDeterministic(prepared.flatMap((item) => item.rows));
      await updateSourceExtractionStatus(store, projectId, sources.map((source) => source.id), 'degraded', undefined, prepared, state.sourceTexts);
    }
    if (proposalItems.length) proposal = await store.transact((draft) => {
      const target = draft.workspaces.find((item) => item.project.id === projectId);
      if (!target) throw new ApiError(404, 'Project not found.');
      return addProposal(target, proposalItems, sources.map((source) => source.id), providerMode, providerModel, 'Source review proposals');
    });
    const extraction = publicExtraction(prepared, proposalItems.length, providerMode, providerModel, extractionError, missingInfo);
    extraction.error = extractionError || (proposalItems.length ? undefined : 'No AI provider ran. The saved sources remain available; recognized structured tables may produce deterministic proposals.');
    return encodeJson({ sources, extraction, proposal });
  }
  if (segments.length === 3 && segments[2] === 'diagnosis' && method === 'POST') {
    const state = await store.read((value) => value);
    const workspace = state.workspaces.find((item) => item.project.id === projectId);
    if (!workspace) throw new ApiError(404, 'Project not found.');
    const prepared = workspace.sources.map((source): PublicFileWork => ({
      source, text: state.sourceTexts[source.id] || '', rows: [],
      result: { text: state.sourceTexts[source.id] || '', parserStatus: source.parser_status, mediaType: source.media_type, rows: [], note: source.extraction_note || '' },
    }));
    const ai = await aiItemsFor(options, request, workspace, workspace.sources, state.sourceTexts, 'diagnosis');
    const items = ai.items;
    if (ai.sourceIds.length) await updateSourceExtractionStatus(store, projectId, ai.sourceIds, ai.result ? 'model' : 'degraded', ai.error, prepared, state.sourceTexts);
    let proposal: ProjectProposal | null = null;
    if (items.length) proposal = await store.transact((draft) => {
      const target = draft.workspaces.find((item) => item.project.id === projectId);
      if (!target) throw new ApiError(404, 'Project not found.');
      return addProposal(target, items, [...new Set(items.flatMap((item) => item.source_refs.map((ref) => ref.source_id)))], 'model', ai.result?.provider_model || null, 'Project diagnosis proposals');
    });
    const extraction = publicExtraction(prepared, items.length, ai.result ? 'model' : 'degraded', ai.result?.provider_model || null, ai.error,
      ai.result?.missing_info || (request.headers.get('X-TeamCreator-AI') !== '1' ? ['AI sharing is off. Public browser diagnosis did not send source text to a provider.'] : []));
    return encodeJson({ extraction, proposal });
  }
  if (segments.length >= 4 && segments[2] === 'proposals' && segments[3]) {
    const proposalId = segments[3];
    if (segments.length === 5 && method === 'POST' && (segments[4] === 'apply' || segments[4] === 'reject')) {
      return proposalAction(store, projectId, proposalId, segments[4], request);
    }
    if (segments.length === 7 && segments[4] === 'items' && segments[6] === 'review' && method === 'POST') {
      const body = await safeJSON(request);
      try {
        const result = await store.transact((state) => {
          const workspace = state.workspaces.find((item) => item.project.id === projectId);
          if (!workspace) throw new ApiError(404, 'Project not found.');
          try { return reviewProposalItem(workspace, proposalId, segments[5], body); }
          catch (error) { throw new ApiError(400, error instanceof Error ? error.message : 'Proposal review was rejected.'); }
        });
        return encodeJson(result);
      } catch (error) { throw error; }
    }
  }
  if (segments.length === 4 && segments[2] === 'records' && method === 'POST') {
    const kind = kindFromRoute(segments[3]);
    if (!kind) throw new ApiError(400, 'Unknown record type.');
    const body = await safeJSON(request);
    const title = typeof body?.title === 'string' ? body.title.trim() : '';
    if (!title || title.length > 240) throw new ApiError(400, 'Enter a record title up to 240 characters.');
    const result = await store.transact((state) => {
      const workspace = state.workspaces.find((item) => item.project.id === projectId);
      if (!workspace) throw new ApiError(404, 'Project not found.');
      if (recordArray(workspace, kind).some((record) => record.title.trim().toLowerCase() === title.toLowerCase())) throw new ApiError(409, 'A record with this title already exists.');
      const fields = body as Partial<ProjectRecord>;
      const dependsOn = Array.isArray(fields.depends_on) ? fields.depends_on : [];
      const knownIds = new Set(allRecords(workspace).map((item) => item.id));
      if (dependsOn.some((id) => typeof id !== 'string' || !knownIds.has(id))) throw new ApiError(400, 'A dependency reference is invalid.');
      const recordId = uid(`${store.idPrefix}-record`);
      let supplemental: Partial<ProjectRecord>;
      try { supplemental = validateSupplementalRecordFields(fields, kind, workspace.members, recordId); }
      catch (error) { throw new ApiError(400, error instanceof Error ? error.message : 'The additional record fields are invalid.'); }
      const record: ProjectRecord = {
        ...blankRecord(kind, title), ...supplemental,
        id: recordId, kind, title, status: fields.status ?? null, owner: fields.owner ?? null, owner_id: null,
        due: fields.due ?? null, due_basis: fields.due_basis || (fields.due ? 'reported' : 'unknown'), completed_at: fields.completed_at ?? null,
        baseline_due: fields.baseline_due ?? null, current_forecast: fields.current_forecast ?? null, depends_on: [...dependsOn],
        source_refs: [], field_refs: {}, evidence_state: 'expert_observation', review_state: 'manager_confirmed',
        created_at: now(), updated_at: now(), description: fields.description ?? null, role: fields.role ?? null,
        member_type: fields.member_type, reason: typeof fields.reason === 'string' ? fields.reason : 'Manager added a record manually.',
      };
      record.dependency_refs = Object.fromEntries(record.depends_on.map((dependencyId) => [dependencyId, []]));
      recordArray(workspace, kind).push(record);
      addAudit(workspace, 'record_created', `Manager added ${kind}: ${title}`, { record_id: record.id, after: clone(record) });
      addChange(workspace, 'record_created', `${kind}: ${title}`, String(fields.reason || 'Manager added a record manually.'), [], 'manager_confirmed');
      refreshGraph(workspace);
      try { assertTaskDependencyAcyclic(allRecords(workspace)); }
      catch (error) { throw new ApiError(400, error instanceof Error ? error.message : 'This dependency would create a cycle.'); }
      return { record, graph: workspace.graph };
    });
    return encodeJson(result, 201);
  }
  if (segments.length === 5 && segments[2] === 'records' && method === 'PATCH') {
    const kind = kindFromRoute(segments[3]);
    if (!kind) throw new ApiError(400, 'Unknown record type.');
    const body = await safeJSON(request);
    const result = await store.transact((state) => {
      const workspace = state.workspaces.find((item) => item.project.id === projectId);
      const record = workspace && recordArray(workspace, kind).find((item) => item.id === segments[4]);
      if (!workspace || !record) throw new ApiError(404, 'Project or record not found.');
      const before = clone(record);
      const allowed = ['title', 'status', 'owner', 'due', 'due_basis', 'completed_at', 'baseline_due', 'current_forecast', 'description', 'role', 'member_type', 'depends_on', 'documented_skills', 'availability_note', 'planned_start', 'planned_duration_days', 'effort_hours', 'collaboration_profile', 'reason'];
      const keys = Object.keys(body || {}).filter((key) => allowed.includes(key));
      if (!keys.length) throw new ApiError(400, 'The record update contains no supported fields.');
      let supplemental: Partial<ProjectRecord>;
      try { supplemental = validateSupplementalRecordFields(body, kind, workspace.members, record.id); }
      catch (error) { throw new ApiError(400, error instanceof Error ? error.message : 'The additional record fields are invalid.'); }
      for (const key of keys) (record as unknown as Record<string, unknown>)[key] = body[key];
      Object.assign(record, supplemental);
      if (keys.includes('owner')) record.owner_id = null;
      if (keys.includes('depends_on')) {
        const known = new Set(allRecords(workspace).map((item) => item.id));
        if (!Array.isArray(record.depends_on) || record.depends_on.some((id) => !known.has(id)) || record.depends_on.includes(record.id)) throw new ApiError(400, 'A dependency reference is invalid.');
        record.dependency_refs = Object.fromEntries(record.depends_on.map((id) => [id, []]));
        record.unresolved_dependencies = [];
      }
      record.updated_at = now(); record.review_state = 'manager_corrected'; record.evidence_state = 'expert_observation';
      record.field_refs = { ...(record.field_refs || {}) };
      for (const key of keys) record.field_refs[key] = [];
      addAudit(workspace, 'record_edited', `Manager edited ${kind}: ${record.title}`, { record_id: record.id, before, after: clone(record) });
      addChange(workspace, 'record_edited', `${kind}: ${record.title}`, String(body.reason || 'Manager corrected a project record.'), [], 'manager_corrected');
      refreshGraph(workspace);
      try { assertTaskDependencyAcyclic(allRecords(workspace)); }
      catch (error) { throw new ApiError(400, error instanceof Error ? error.message : 'This dependency change would create a cycle.'); }
      return { record, graph: workspace.graph };
    });
    return encodeJson(result);
  }
  if (segments.length === 3 && segments[2] === 'impact' && method === 'GET') {
    const workspace = await workspaceRead();
    if (!workspace) throw new ApiError(404, 'Project not found.');
    const taskId = url.searchParams.get('taskId') || '';
    if (!taskId) throw new ApiError(400, 'Choose a task to calculate downstream impact.');
    return encodeJson(impactFor(workspace, taskId));
  }
  throw new ApiError(404, 'Public API route not found.');
}

function parseStructuredTextSafe(text: string, name: string) {
  // Retry works from saved text and does not attempt unsupported formats or a model by default.
  return text ? parseStructuredText(text, name) : [];
}

function requestedItemIds(body: any): Set<string> {
  if (!Array.isArray(body?.itemIds) || !body.itemIds.length || body.itemIds.some((id: unknown) => typeof id !== 'string')) throw new ApiError(400, 'Choose at least one proposal item to apply.');
  return new Set(body.itemIds as string[]);
}

async function proposalAction(store: PublicRuntimeStore, projectId: string, proposalId: string, action: string, request: Request): Promise<Response> {
  const body = await safeJSON(request);
  if (action === 'apply') {
    const selected = requestedItemIds(body);
    const result = await store.transact((state) => {
      const workspace = state.workspaces.find((item) => item.project.id === projectId);
      const proposal = workspace?.proposals.find((item) => item.id === proposalId);
      if (!workspace || !proposal || proposal.status !== 'proposed') throw new ApiError(404, 'Pending proposal not found.');
      const stale = proposal.items.filter((item) => selected.has(item.id) && item.operation === 'update').find((item) => {
        const record = item.record_id ? allRecords(workspace).find((candidate) => candidate.id === item.record_id) : undefined;
        if (!record) return true;
        return Object.entries(item.before || {}).some(([field, value]) => JSON.stringify((record as unknown as Record<string, unknown>)[field] ?? null) !== JSON.stringify(value ?? null));
      });
      if (stale) throw new ApiError(409, 'The project changed after this proposal was prepared. Review the current record and correct the proposal before applying it.');
      let applied = 0;
      const appliedItemIds: string[] = [];
      for (const item of proposal.items) {
        if (!selected.has(item.id) || item.conflict || item.review_state === 'manager_confirmed') continue;
        const fields = { ...item.fields } as Partial<ProjectRecord>;
        const title = typeof fields.title === 'string' ? fields.title : item.title;
        delete fields.title;
        if (item.operation === 'create') {
          const record: ProjectRecord = {
            ...blankRecord(item.record_kind, title), ...fields, id: uid(`${store.idPrefix}-record`), kind: item.record_kind,
            title, source_refs: item.source_refs, evidence_state: fields.evidence_state || 'supported', review_state: 'manager_confirmed',
            created_at: now(), updated_at: now(),
          };
          recordArray(workspace, item.record_kind).push(record);
          item.operation = 'update'; item.record_id = record.id; item.before = null;
        } else {
          const record = item.record_id ? allRecords(workspace).find((candidate) => candidate.id === item.record_id && candidate.kind === item.record_kind) : undefined;
          if (!record) continue;
          const before = clone(record);
          Object.assign(record, fields, { title, review_state: 'manager_confirmed', updated_at: now() });
          record.field_refs = { ...(record.field_refs || {}) };
          if (typeof item.fields.title === 'string') record.field_refs.title = item.fields.field_refs?.title || [];
          for (const field of Object.keys(fields)) {
            if (field === 'field_refs' || field === 'source_refs') continue;
            record.field_refs[field] = item.fields.field_refs?.[field] || [];
          }
          item.before = Object.fromEntries(Object.keys(fields).concat('title').map((field) => [field, (before as unknown as Record<string, unknown>)[field]]));
        }
        item.review_state = 'manager_confirmed';
        const recordId = item.record_id || undefined;
        addAudit(workspace, 'proposal_applied', `Applied ${item.record_kind}: ${title}`, { source_ids: item.source_refs.map((ref) => ref.source_id), proposal_id: proposal.id, record_id: recordId, after: clone(item.fields) });
        addChange(workspace, 'proposal_applied', `${item.record_kind}: ${title}`, `Manager applied a source-grounded update from ${proposal.title}.`, item.source_refs, 'manager_confirmed', proposal.id);
        applied += 1; appliedItemIds.push(item.id);
      }
      const complete = proposal.conflicts.length === 0 && proposal.items.every((item) => item.review_state === 'manager_confirmed');
      if (complete) { proposal.status = 'applied'; proposal.decided_at = now(); }
      proposal.summary = complete ? `Manager applied ${applied} source-grounded change${applied === 1 ? '' : 's'}.` : `${applied} change${applied === 1 ? '' : 's'} applied. Other proposal items still need review.`;
      addAudit(workspace, 'proposal_applied', proposal.summary, { source_ids: proposal.source_ids, proposal_id: proposal.id });
      refreshGraph(workspace);
      try { assertTaskDependencyAcyclic(allRecords(workspace)); }
      catch (error) { throw new ApiError(409, `${error instanceof Error ? error.message : 'Applying these changes would create a dependency cycle.'} No proposal items were saved.`); }
      return { proposal, graph: workspace.graph, applied, conflicts_remaining: proposal.conflicts.length, applied_item_ids: appliedItemIds,
        remaining_item_ids: proposal.items.filter((item) => item.review_state !== 'manager_confirmed').map((item) => item.id) };
    });
    return encodeJson(result);
  }
  if (action === 'reject') {
    const result = await store.transact((state) => {
      const workspace = state.workspaces.find((item) => item.project.id === projectId);
      const proposal = workspace?.proposals.find((item) => item.id === proposalId);
      if (!workspace || !proposal) throw new ApiError(404, 'Proposal not found.');
      if (proposal.status === 'proposed') {
        proposal.status = 'rejected'; proposal.decided_at = now();
        proposal.decision_reason = typeof body.reason === 'string' ? body.reason.slice(0, 1_000) : undefined;
        for (const item of proposal.items) if (item.review_state !== 'manager_confirmed') item.review_state = 'unresolved';
        addAudit(workspace, 'proposal_rejected', `Manager rejected: ${proposal.title}`, { proposal_id: proposal.id, source_ids: proposal.source_ids });
        addChange(workspace, 'proposal_rejected', proposal.title, 'Manager rejected the proposed update. Live records were left unchanged.', proposal.items.flatMap((item) => item.source_refs), 'unresolved', proposal.id);
      }
      return { proposal };
    });
    return encodeJson(result);
  }
  throw new ApiError(404, 'Proposal action not found.');
}

function blankRecord(kind: RecordKind, title: string): ProjectRecord {
  return { id: '', kind, title, status: null, owner: null, owner_id: null, due: null, due_basis: 'unknown', completed_at: null,
    baseline_due: null, current_forecast: null, depends_on: [], source_refs: [], field_refs: {}, evidence_state: 'supported',
    review_state: 'unreviewed', created_at: now(), updated_at: now() };
}

function isPublicApiUrl(value: string, base: string): URL | null {
  try {
    const url = new URL(value, base);
    return url.origin === new URL(base).origin && url.pathname.startsWith('/api/') ? url : null;
  } catch { return null; }
}

function installXhrBridge(apiRequest: PublicApiHandler): () => void {
  const NativeXHR = window.XMLHttpRequest;
  const PatchedXHR = new Proxy(NativeXHR, {
    construct(target, args, newTarget) {
      const xhr = Reflect.construct(target, args, newTarget) as XMLHttpRequest;
      const openNative = xhr.open.bind(xhr);
      const sendNative = xhr.send.bind(xhr);
      const setHeaderNative = xhr.setRequestHeader.bind(xhr);
      let localUrl = '';
      let localMethod = 'GET';
      let localHeaders = new Headers();
      let local = false;
      let status = 0;
      let responseText = '';
      let readyState = 0;
      let responseValue: Document | XMLHttpRequestBodyInit | null = null;
      (xhr.open as any) = (method: string, url: string | URL, async = true, user?: string | null, password?: string | null) => {
        const parsed = isPublicApiUrl(String(url), window.location.href);
        local = !!parsed && !parsed.pathname.startsWith('/api/ai/');
        if (!local) return openNative(method, url, async, user, password);
        localUrl = parsed!.href; localMethod = method.toUpperCase(); localHeaders = new Headers();
        status = 0; responseText = ''; responseValue = null; readyState = 1;
        for (const key of ['status', 'statusText', 'responseText', 'response', 'readyState', 'responseURL']) {
          try {
            Object.defineProperty(xhr, key, { configurable: true, get: () => key === 'status' ? status : key === 'statusText' ? (status === 200 || status === 201 ? 'OK' : 'Error') : key === 'responseText' ? responseText : key === 'response' ? responseValue : key === 'readyState' ? readyState : localUrl });
          } catch { /* Native property may not be configurable in this browser. */ }
        }
        xhr.dispatchEvent(new Event('readystatechange'));
      };
      (xhr.setRequestHeader as any) = (name: string, value: string) => { if (local) localHeaders.set(name, value); else setHeaderNative(name, value); };
      (xhr.send as any) = (body: Document | XMLHttpRequestBodyInit | null = null) => {
        if (!local) return sendNative(body);
        if (body instanceof FormData) {
          const loaded = [...body.entries()].reduce((total, [, value]) => total + (value instanceof File ? value.size : String(value).length), 0);
          const progress = new ProgressEvent('progress', { lengthComputable: true, loaded, total: loaded });
          xhr.upload.dispatchEvent(progress);
        }
        const init: RequestInit = { method: localMethod, headers: localHeaders };
        if (body !== null) init.body = body as BodyInit;
        const task = apiRequest(new Request(localUrl, init));
        void task.then(async (response) => {
          status = response.status; responseText = await response.text(); responseValue = responseText; readyState = 4;
          xhr.dispatchEvent(new Event('readystatechange'));
          const event = new ProgressEvent('load', { lengthComputable: true, loaded: responseText.length, total: responseText.length });
          xhr.dispatchEvent(event);
          xhr.upload.dispatchEvent(new ProgressEvent('load', { lengthComputable: true, loaded: responseText.length, total: responseText.length }));
          xhr.upload.dispatchEvent(new ProgressEvent('loadend'));
          xhr.dispatchEvent(new ProgressEvent('loadend'));
        }).catch((error) => {
          status = 0; responseText = ''; readyState = 4; xhr.dispatchEvent(new Event('readystatechange'));
          const event = new ProgressEvent('error'); xhr.dispatchEvent(event); xhr.dispatchEvent(new ProgressEvent('loadend'));
        });
      };
      return xhr;
    },
  });
  window.XMLHttpRequest = PatchedXHR;
  return () => { window.XMLHttpRequest = NativeXHR; };
}

export function createPublicApiHandler(
  options: PublicRuntimeOptions = {}, store: PublicRuntimeStore = new PublicBrowserStore(), nativeFetch: typeof fetch = fetch,
): PublicApiHandler {
  return (request) => handlePublicRequest(request, store, options, nativeFetch).catch((error) => {
    const output = publicError(error);
    return encodeJson(output.body, output.status);
  });
}

export function installPublicRuntime(options: PublicRuntimeOptions = {}): () => void {
  const store = new PublicBrowserStore();
  const nativeFetch = window.fetch.bind(window);
  const originalFetch = window.fetch;
  const apiRequest = createPublicApiHandler(options, store, nativeFetch);
  window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const value = input instanceof Request ? input.url : String(input);
    const parsed = isPublicApiUrl(value, window.location.href);
    if (!parsed || parsed.pathname.startsWith('/api/ai/')) return nativeFetch(input, init);
    const request = input instanceof Request ? new Request(input, init) : new Request(parsed.href, init);
    return apiRequest(request);
  }) as typeof fetch;
  const removeXhr = installXhrBridge(apiRequest);
  return () => { window.fetch = originalFetch; removeXhr(); };
}
