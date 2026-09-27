import { createHash, randomUUID } from 'node:crypto';
import express, { type NextFunction, type Request, type Response } from 'express';
import multer from 'multer';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type {
  AuditEvent, ExtractionSummary, IngestResult, JobEvent, JobSnapshot, ParsedFileResult, ProjectChange,
  ProjectProposal, ProjectRecord, ProjectSource, ProjectWorkspace, SourceRef,
} from '../shared/types.js';
import { JsonStore, type JobCreationResult } from './store.js';
import { checkinSourceName, parseSource, safeRelativePath, safeSourceName, type ParsedSource } from './parser.js';
import { extractWithCodex, inspectCodexCli, markProviderUnavailable, providerSnapshot, ProviderError } from './provider.js';
import type { ModelExtraction } from './provider.js';
import { buildOwnerAssignments, buildProposal, labelPriorBatchDiagnostics, manualDependencySelection, mergeProposalIntoPending, newProjectRecord, normalizePendingProposalItems, normalizedKey, resolveDependencyPlaceholders, resolveOwnerPlaceholders } from './reconcile.js';
import { holdBaselineApprovalStatuses } from '../shared/proposal-safety.js';
import { itemReviewSchema, reviewProposalItem } from '../shared/proposal-review.js';
import { getProjectContext, proposeProjectChanges } from '../shared/agent-context.js';
import { assertTaskDependencyAcyclic, DependencyCycleError } from '../shared/dependency-validation.js';
import { collaborationProfileSchema, validateCollaborationReferences, CollaborationReferenceError } from '../shared/collaboration-profile.js';
import { runSimulation, createDefaultSimulationConfig } from '../shared/simulation.js';
import { calculateImpact, findDependencyCycles } from './impact.js';
import { buildSyntheticDemoWorkspace } from './demo-fixture.js';
import { extractionCoverage, nextSourceBatch, splitSourceText, type PendingSourceSegment } from './coverage.js';
import { buildProjectExport } from './exports.js';

const API_PORT = Number(process.env.TC_GIGAHACK_API_PORT || 3001);
const MAX_UPLOAD_BYTES = 60 * 1024 * 1024;
const UPLOAD_LIMIT = 12;
const SEGMENTS_PER_PROVIDER_REQUEST = 4;
const JOBS_KEEP = 80;
const JOB_EVENTS_KEEP = 250;
const DEFAULT_JOB_SEGMENT_BUDGET = 40;
const app = express();
const store = new JsonStore();
const jobs = new Map<string, JobSnapshot>();

app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { files: UPLOAD_LIMIT, fileSize: 16 * 1024 * 1024, fieldSize: 512 * 1024, fields: 40 },
});

const now = () => new Date().toISOString();
const id = () => randomUUID();
const actor = 'local manager';

function appendAudit(workspace: ProjectWorkspace, item: Omit<AuditEvent, 'id' | 'project_id' | 'at' | 'actor'>) {
  workspace.audit.unshift({ id: id(), project_id: workspace.project.id, at: now(), actor, ...item });
  workspace.audit = workspace.audit.slice(0, 1_000);
}

function appendChange(workspace: ProjectWorkspace, item: Omit<ProjectChange, 'id' | 'project_id' | 'at'>) {
  workspace.changes.unshift({ id: id(), project_id: workspace.project.id, at: now(), ...item });
  workspace.changes = workspace.changes.slice(0, 500);
  workspace.project.updated_at = now();
}

function allRecords(workspace: ProjectWorkspace) {
  return [workspace.members, workspace.tasks, workspace.deliverables, workspace.risks, workspace.decisions].flat();
}

function pendingProposalRecords(workspace: ProjectWorkspace) {
  return workspace.proposals.filter((proposal) => proposal.status === 'proposed').flatMap((proposal) =>
    proposal.items.filter((item) => item.review_state !== 'manager_confirmed' && item.review_state !== 'manager_corrected').map((item) =>
      newProjectRecord({
        ...(item.before || {}),
        ...item.fields,
        id: `draft:${item.id}`,
        kind: item.record_kind,
        title: item.title,
        source_refs: item.source_refs,
      }),
    ),
  ).slice(0, 120);
}

function mapPendingTargets(extraction: ModelExtraction, workspace: ProjectWorkspace): ModelExtraction {
  const draftItems = new Map<string, ProjectProposal['items'][number]>(workspace.proposals.filter((proposal) => proposal.status === 'proposed')
    .flatMap((proposal) => proposal.items.map((item) => [`draft:${item.id}`, item] as const)));
  return {
    ...extraction,
    records: extraction.records.map((record) => {
      const draftId = record.target_record_id;
      const item = draftId ? draftItems.get(draftId) : undefined;
      if (!item) return record;
      return {
        ...record,
        target_record_id: item.record_id,
        match_basis: item.record_id ? 'contextual' as const : 'new' as const,
      };
    }),
  };
}

function newWorkspace(name: string, synthetic = false): ProjectWorkspace {
  const timestamp = now();
  const projectId = id();
  return {
    project: { id: projectId, name: name.trim().slice(0, 150), created_at: timestamp, updated_at: timestamp, synthetic },
    members: [],
    tasks: [],
    deliverables: [],
    risks: [],
    decisions: [],
    dependencies: [],
    assignments: [],
    sources: [],
    proposals: [],
    changes: [],
    audit: [],
    graph: { cycles: [], has_cycles: false },
  };
}

function refreshGraph(workspace: ProjectWorkspace) {
  const records = allRecords(workspace);
  const cycles = findDependencyCycles(workspace);
  workspace.graph = { cycles, has_cycles: cycles.length > 0 };
  workspace.dependencies = records.flatMap((record) => record.depends_on.map((prerequisiteId) => ({
    id: `${record.id}:${prerequisiteId}`,
    from_id: record.id,
    to_id: prerequisiteId,
    evidence_state: record.dependency_refs?.[prerequisiteId]?.length ? 'supported' as const : 'expert_observation' as const,
    source_refs: record.dependency_refs?.[prerequisiteId] || [],
  })));
  workspace.assignments = buildOwnerAssignments(workspace);
}

function getRecordArray(workspace: ProjectWorkspace, kind: ProjectRecord['kind']) {
  if (kind === 'member') return workspace.members;
  if (kind === 'task') return workspace.tasks;
  if (kind === 'deliverable') return workspace.deliverables;
  if (kind === 'risk') return workspace.risks;
  return workspace.decisions;
}

function addStoredRecord(workspace: ProjectWorkspace, record: ProjectRecord) {
  getRecordArray(workspace, record.kind).push(record);
}

function updateJob(jobId: string, update: Partial<JobSnapshot>) {
  const job = jobs.get(jobId);
  if (!job) return;
  const previousPhase = job.phase;
  const previousStatus = job.status;
  const previousProgress = job.progress;
  Object.assign(job, update, { updated_at: now() });
  job.progress = Math.max(previousProgress, Math.min(100, Math.max(0, job.progress)));
  job.events ||= [];
  job.event_sequence ||= 0;
  if (job.phase !== previousPhase || job.status !== previousStatus || job.progress !== previousProgress) {
    const type: JobEvent['type'] = job.status !== previousStatus && ['completed', 'partial', 'failed'].includes(job.status)
      ? job.status as JobEvent['type']
      : job.phase !== previousPhase ? 'phase' : 'progress';
    job.event_sequence += 1;
    job.events.push({
      sequence: job.event_sequence,
      at: job.updated_at,
      type,
      phase: job.phase,
      progress: job.progress,
      message: job.error || job.phase,
    });
    job.events = job.events.slice(-JOB_EVENTS_KEEP);
  }
  void store.saveJob(job).catch(() => process.stderr.write('Could not persist local processing job state.\n'));
}

function boundedJobSegmentBudget() {
  const value = Number(process.env.TC_GIGAHACK_MAX_JOB_SEGMENTS);
  return Number.isFinite(value) ? Math.max(SEGMENTS_PER_PROVIDER_REQUEST, Math.min(400, Math.round(value))) : DEFAULT_JOB_SEGMENT_BUDGET;
}

function requestKey(request: Request, response: Response) {
  const key = request.get('Idempotency-Key')?.trim() || '';
  if (!/^[A-Za-z0-9._:-]{8,128}$/.test(key)) {
    response.status(400).json({ error: 'Provide an Idempotency-Key between 8 and 128 letters, digits, dots, underscores, colons, or hyphens.' });
    return undefined;
  }
  return key;
}

function requireRequestKey(request: Request, response: Response, next: NextFunction) {
  if (!requestKey(request, response)) return;
  next();
}

function fingerprint(value: string | Buffer) {
  return createHash('sha256').update(value).digest('hex');
}

function sendJobCreation(response: Response, outcome: JobCreationResult) {
  if (outcome.outcome === 'conflict') {
    const message = outcome.reason === 'idempotency_key_reused'
      ? 'This Idempotency-Key was already used with a different request body.'
      : outcome.reason === 'receipt_expired'
        ? 'The idempotency receipt has expired from retained job history. Submit again with a new key.'
        : 'Another processing job is already running for this project.';
    return response.status(409).json({ error: message, ...(outcome.active_job_id ? { job_id: outcome.active_job_id } : {}) });
  }
  return response.status(outcome.outcome === 'created' ? 202 : 200).json({ job: outcome.job, ...(outcome.outcome === 'replayed' ? { replayed: true } : {}) });
}

async function createJob(
  projectId: string,
  kind: JobSnapshot['kind'],
  request: { scope: string; key: string; fingerprint: string },
  work: (jobId: string) => Promise<IngestResult>,
  prepare?: () => Promise<void>,
) {
  const timestamp = now();
  const job: JobSnapshot = {
    id: id(),
    project_id: projectId,
    kind,
    status: 'queued',
    phase: 'Queued for local processing',
    progress: 1,
    segment_budget: boundedJobSegmentBudget(),
    event_sequence: 1,
    events: [{ sequence: 1, at: timestamp, type: 'queued', phase: 'Queued for local processing', progress: 1, message: 'The request passed validation and is queued.' }],
    created_at: timestamp,
    updated_at: timestamp,
  };
  const created = await store.createJob(job, request);
  if (created.outcome !== 'created') return created;
  jobs.set(job.id, job);
  while (jobs.size > JOBS_KEEP) jobs.delete(jobs.keys().next().value as string);
  try {
    await prepare?.();
  } catch (error) {
    const message = error instanceof Error ? error.message : 'The request could not be prepared safely.';
    updateJob(job.id, {
      status: 'failed',
      phase: 'Could not prepare processing',
      progress: 100,
      error: message,
    });
    return { outcome: 'created' as const, job };
  }
  void work(job.id).then((result) => {
    const complete = result.extraction.coverage?.complete === true;
    updateJob(job.id, {
      status: complete ? 'completed' : 'partial',
      phase: complete ? 'Complete' : 'Partial result ready',
      progress: 100,
      result,
      segments_total: result.extraction.coverage?.total_segments,
      segments_processed: Math.max(0, (result.extraction.coverage?.total_segments || 0) - (result.extraction.coverage?.segments_remaining || 0)),
      segments_remaining: result.extraction.coverage?.segments_remaining,
    });
  }).catch((error) => {
    updateJob(job.id, {
      status: 'failed',
      phase: 'Stopped',
      progress: 100,
      error: error instanceof Error ? error.message : 'Local processing failed. Check the source files and try again.',
    });
  });
  return created;
}

function fileResult(source: ProjectSource): ParsedFileResult {
  return {
    name: source.relative_path || source.name,
    status: source.parser_status === 'parsed' ? (source.error || 'Parsed') : source.parser_status === 'empty' ? 'Empty' : 'Failed',
    parser_status: source.parser_status,
    source_id: source.id,
    ...(source.error ? { error: source.error } : {}),
    ...(source.excerpt ? { excerpt: source.excerpt } : {}),
    ...(source.parsed_text_characters !== undefined ? { parsed_text_characters: source.parsed_text_characters } : {}),
    ...(source.segments_total !== undefined ? { segments_total: source.segments_total } : {}),
    ...(source.processed_segments !== undefined ? { processed_segments: source.processed_segments } : {}),
    ...(source.parse_coverage ? { parse_coverage: source.parse_coverage } : {}),
    ...(source.extraction_coverage ? { extraction_coverage: source.extraction_coverage } : {}),
    ...(source.coverage_note ? { coverage_note: source.coverage_note } : {}),
    ...(source.extraction_note ? { extraction_note: source.extraction_note } : {}),
    ...(source.fixture_only ? { fixture_only: true } : {}),
  };
}

function safeNameForSource(raw: string) {
  return safeSourceName(raw).replace(/[\u0000-\u001f]/g, '').slice(0, 180) || 'source';
}

function canReparseSource(source: ProjectSource) {
  const extension = source.name.toLocaleLowerCase().split('.').pop() || '';
  return ['md', 'markdown', 'txt', 'pdf', 'docx', 'csv', 'xlsx', 'xls'].includes(extension);
}

function mimeForName(name: string, supplied: string) {
  const ext = name.toLowerCase().split('.').pop();
  const known: Record<string, string> = {
    md: 'text/markdown', markdown: 'text/markdown', txt: 'text/plain', pdf: 'application/pdf',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    csv: 'text/csv', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', xls: 'application/vnd.ms-excel',
  };
  return ext && known[ext] ? known[ext] : supplied || 'application/octet-stream';
}

function nextSources(workspace: ProjectWorkspace, parsed: ParsedSource[], savedPaths: Map<string, string>, savedTextIds: Set<string>) {
  const allSources: ProjectSource[] = [];
  const previous = [...workspace.sources];
  for (const item of parsed) {
    const sha256 = createHash('sha256').update(item.bytes).digest('hex');
    const duplicate = previous.find((source) => source.sha256 === sha256);
    const source: ProjectSource = {
      id: item.sourceId,
      name: safeNameForSource(item.name),
      relative_path: item.relativePath,
      sha256,
      size: item.bytes.length,
      media_type: mimeForName(item.name, item.mediaType),
      parser_status: item.status,
      parsed_text_characters: item.parsedTextCharacters,
      segments_total: splitSourceText(item.text).length,
      processed_segments: [],
      parse_coverage: item.parseCoverage,
      extraction_coverage: item.status === 'parsed' && savedTextIds.has(item.sourceId) ? 'pending' : 'unavailable',
      created_at: now(),
      ...(item.excerpt ? { excerpt: item.excerpt } : {}),
      ...(item.error ? { error: item.error } : {}),
      ...(item.coverageNote ? { coverage_note: item.coverageNote } : {}),
      ...(duplicate ? { duplicate_of: duplicate.id } : {}),
    };
    if (!savedPaths.has(item.sourceId)) {
      source.parser_status = 'failed';
      source.error = 'The source could not be saved to the local project store.';
      source.extraction_coverage = 'unavailable';
    } else if (item.status === 'parsed' && !savedTextIds.has(item.sourceId)) {
      source.parser_status = 'failed';
      source.error = 'The original file was saved, but its parsed text could not be saved locally.';
      source.extraction_coverage = 'unavailable';
    }
    allSources.push(source);
    previous.push(source);
  }
  return allSources;
}

async function recordSources(projectId: string, parsed: ParsedSource[]) {
  const savedPaths = new Map<string, string>();
  const savedTextIds = new Set<string>();
  for (const item of parsed) {
    try {
      const relative = await store.saveSourceFile(projectId, item.sourceId, item.name, item.bytes);
      savedPaths.set(item.sourceId, relative);
      if (item.status === 'parsed') {
        await store.saveSourceText(item.sourceId, item.text);
        savedTextIds.add(item.sourceId);
      }
    } catch {
      // Keep a visible failed source record even if local file archival fails.
    }
  }
  let sources: ProjectSource[] = [];
  await store.transact((state) => {
    const workspace = state.workspaces.find((candidate) => candidate.project.id === projectId);
    if (!workspace) throw new Error('Project workspace was removed before source processing finished.');
    sources = nextSources(workspace, parsed, savedPaths, savedTextIds);
    for (const source of sources) {
      workspace.sources.unshift(source);
      const item = parsed.find((candidate) => candidate.sourceId === source.id);
      const stored = savedPaths.get(source.id);
      if (stored) state.sourceFiles[source.id] = stored;
    }
    workspace.sources = workspace.sources.slice(0, 1_000);
    const names = sources.map((source) => source.relative_path || source.name);
    appendAudit(workspace, { type: 'source_added', summary: `${sources.length} source${sources.length === 1 ? '' : 's'} added: ${names.join(', ')}`.slice(0, 500), source_ids: sources.map((source) => source.id) });
    appendChange(workspace, { type: 'source_added', title: 'Project sources added', summary: `${sources.length} source${sources.length === 1 ? '' : 's'} added for review.`, source_refs: [], review_state: 'unreviewed' });
    refreshGraph(workspace);
  });
  return sources;
}

async function prepareLegacySourceCoverage(projectId: string, sources: ProjectSource[]) {
  for (const source of sources) {
    if (source.fixture_only) continue;
    const retryFailedParse = source.parser_status === 'failed' && canReparseSource(source);
    if (!retryFailedParse && source.segments_total !== undefined && source.processed_segments && source.parse_coverage) continue;
    let text = await store.getSourceText(source.id);
    let parseCoverage: ProjectSource['parse_coverage'] = 'legacy_unknown';
    let parsedSource: ParsedSource | undefined;
    const original = await store.getSourceFile(source.id);
    if (original) {
      parsedSource = await parseSource({ name: source.name, relativePath: source.relative_path, mediaType: source.media_type, bytes: original }, source.id);
      if (parsedSource.status === 'parsed') {
        try {
          await store.saveSourceText(source.id, parsedSource.text);
          text = parsedSource.text;
          parseCoverage = parsedSource.parseCoverage;
        } catch {
          // Keep the legacy extracted text and its explicitly unknown parse coverage.
        }
      }
    }
    if (!text?.trim() && parsedSource?.status === 'parsed') text = parsedSource.text;
    await store.transact((state) => {
      const workspace = state.workspaces.find((item) => item.project.id === projectId);
      const current = workspace?.sources.find((item) => item.id === source.id);
      if (!current) return;
      if (!text?.trim()) {
        if (parsedSource) {
          current.parser_status = parsedSource.status;
          current.error = parsedSource.error || 'The original file could not be parsed.';
        }
        current.extraction_coverage = 'unavailable';
        current.extraction_note = 'Saved parsed text and the original file are unavailable. Re-upload this source to continue extraction.';
        return;
      }
      const total = splitSourceText(text).length;
      current.parsed_text_characters = text.length;
      current.segments_total = total;
      current.processed_segments = [];
      current.parse_coverage = parsedSource?.status === 'parsed' ? parsedSource.parseCoverage : parseCoverage;
      current.parser_status = 'parsed';
      current.extraction_coverage = 'legacy_unknown';
      current.coverage_note = parsedSource?.status !== 'parsed'
        ? 'The original file could not be reparsed. Coverage applies only to the legacy extracted text retained locally.'
        : current.parse_coverage === 'legacy_unknown'
          ? 'This source predates coverage tracking. Its original file was unavailable; coverage applies only to the saved extracted text.'
          : parsedSource?.coverageNote;
      current.extraction_note = 'Coverage tracking started from the first retained text segment.';
      if (parsedSource?.excerpt) current.excerpt = parsedSource.excerpt;
      if (parsedSource?.error) current.error = parsedSource.error;
      else if (parsedSource?.status === 'parsed' || !parsedSource) delete current.error;
    });
  }
}

async function processSourceCoverage(
  projectId: string,
  requestedIds: string[] | undefined,
  jobId: string,
  action: 'ingest' | 'retry',
  reportIds?: string[],
  maxSegments = SEGMENTS_PER_PROVIDER_REQUEST,
) {
  updateJob(jobId, { status: 'running', phase: 'Preparing source coverage', progress: 18 });
  let workspace = await store.getWorkspace(projectId);
  if (!workspace) throw new Error('Project not found.');
  let selected = workspace.sources.filter((source) => !source.fixture_only && (source.parser_status === 'parsed' || (action === 'retry' && source.parser_status === 'failed' && canReparseSource(source))) && (requestedIds === undefined || requestedIds.includes(source.id)));
  await prepareLegacySourceCoverage(projectId, selected);
  workspace = await store.getWorkspace(projectId);
  if (!workspace) throw new Error('Project not found.');
  selected = workspace.sources.filter((source) => !source.fixture_only && source.parser_status === 'parsed' && (requestedIds === undefined || requestedIds.includes(source.id)));
  const visibleIds = new Set(reportIds || requestedIds || selected.map((source) => source.id));
  const reported = workspace.sources.filter((source) => visibleIds.has(source.id));
  const textBySource = new Map<string, string>();
  for (const source of selected) {
    const text = await store.getSourceText(source.id);
    if (text?.trim()) textBySource.set(source.id, text);
  }
  const batch = nextSourceBatch(selected, textBySource, maxSegments);
  const totalSegments = selected.reduce((sum, source) => sum + (source.segments_total || 0), 0);
  const beforeProcessed = selected.reduce((sum, source) => sum + (source.processed_segments?.length || 0), 0);
  const parserLimitedSources = reported.filter((source) => source.parser_status !== 'parsed' || source.parse_coverage !== 'complete').length;
  const modelCompleteBefore = beforeProcessed >= totalSegments;
  const parserComplete = parserLimitedSources === 0;
  if (!batch.length) {
    const unavailable = reported.filter((source) => source.parser_status !== 'parsed' || source.extraction_coverage === 'unavailable');
    const fixtureCount = reported.filter((source) => source.fixture_only).length;
    const note = fixtureCount && !selected.length
      ? 'Synthetic fixture sources remain available for evidence review; the demo fixture itself is not sent for model extraction.'
      : !selected.length
      ? 'No readable text was available. Files are inventoried; no model extraction was claimed.'
      : unavailable.length
        ? `${unavailable.length} source${unavailable.length === 1 ? '' : 's'} could not be fully parsed or have no saved text.`
        : 'No uncovered source segments remain.';
    return {
      sources: reported,
      extraction: {
        provider_mode: 'degraded' as const,
        provider_model: null,
        files: reported.map(fileResult),
        records_proposed: 0,
        conflicts: 0,
        missing_info: [note],
        coverage: {
          segments_sent: 0, total_segments: totalSegments, segments_remaining: Math.max(0, totalSegments - beforeProcessed),
          complete: modelCompleteBefore && parserComplete && selected.length > 0, model_complete: modelCompleteBefore, parser_complete: parserComplete,
          parser_limited_sources: parserLimitedSources,
          ...(!parserComplete ? { note: `${note} Some source pages, rows, columns, or legacy content were not parsed; see each source coverage note.` } : { note }),
        },
      },
      proposal: null,
    } satisfies IngestResult;
  }

  updateJob(jobId, {
    phase: `Extracting source segments ${Math.min(totalSegments, beforeProcessed + batch.length)} of ${totalSegments} with Codex CLI`,
    progress: totalSegments ? Math.min(92, 20 + Math.floor((beforeProcessed / totalSegments) * 70)) : 20,
    segments_total: totalSegments,
    segments_processed: beforeProcessed,
    segments_remaining: Math.max(0, totalSegments - beforeProcessed),
  });
  const batchSourceIds = [...new Set(batch.map((segment) => segment.source_id))];
  const batchSources = selected.filter((source) => batchSourceIds.includes(source.id));
  let proposal: ProjectProposal | null = null;
  let extraction: ExtractionSummary;
  let modelSucceeded = false;
  try {
    const extracted = await extractWithCodex(batch.map((segment) => ({
      source_id: segment.source_id,
      name: `${segment.name} (segment ${segment.index + 1} of ${segment.total})`,
      text: segment.text,
    })), allRecords(workspace), pendingProposalRecords(workspace));
    updateJob(jobId, { phase: 'Checking quotes and comparing with current project state', progress: Math.min(94, 20 + Math.floor(((beforeProcessed + batch.length) / Math.max(totalSegments, 1)) * 70)) });
    const latest = await store.getWorkspace(projectId);
    if (!latest) throw new Error('Project workspace is unavailable.');
    const mapped = mapPendingTargets(extracted, latest);
    proposal = buildProposal(projectId, latest, batchSources, mapped, providerSnapshot().model || 'gpt-6-luna', pendingProposalRecords(latest));
    modelSucceeded = true;
    extraction = {
      provider_mode: 'model',
      provider_model: providerSnapshot().model,
      files: reported.map(fileResult),
      records_proposed: proposal.items.length,
      conflicts: proposal.conflicts.length,
      missing_info: proposal.missing_info,
    };
  } catch (error) {
    if (error instanceof ProviderError && error.kind === 'unavailable') markProviderUnavailable();
    const message = error instanceof ProviderError
      ? error.message
      : 'Model extraction failed safely. Saved sources remain available; no coverage was marked complete.';
    extraction = {
      provider_mode: 'degraded', provider_model: null, files: reported.map(fileResult), records_proposed: 0, conflicts: 0,
      missing_info: [message], error: message,
    };
  }

  updateJob(jobId, { phase: 'Saving proposal and coverage ledger', progress: Math.min(96, 20 + Math.floor(((beforeProcessed + batch.length) / Math.max(totalSegments, 1)) * 72)) });
  const texts = textBySource;
  const selectedSegments = batch;
  await store.transact((state) => {
    const current = state.workspaces.find((entry) => entry.project.id === projectId);
    if (!current) throw new Error('Project workspace is unavailable.');
    if (modelSucceeded) {
      for (const sourceId of batchSourceIds) {
        const source = current.sources.find((item) => item.id === sourceId);
        const text = texts.get(sourceId);
        if (!source || !text) continue;
        const processed = new Set(source.processed_segments || []);
        for (const segment of selectedSegments.filter((item) => item.source_id === sourceId)) processed.add(segment.index);
        const coverage = extractionCoverage(source, [...processed], text);
        Object.assign(source, coverage);
        source.extraction_note = `${coverage.processed_segments.length} of ${coverage.segments_total} text segments sent successfully to the model.`;
      }
      if (proposal) {
        proposal = mergeProposalIntoPending(current, proposal);
        if (!current.proposals.some((item) => item.id === proposal!.id)) current.proposals.unshift(proposal);
        current.proposals = current.proposals.slice(0, 500);
        appendAudit(current, {
          type: action === 'ingest' ? 'proposal_created' : 'extraction_retry',
          summary: `${proposal.items.length} change${proposal.items.length === 1 ? '' : 's'} proposed from ${batch.length} source segment${batch.length === 1 ? '' : 's'}. ${proposal.conflicts.length} conflict${proposal.conflicts.length === 1 ? '' : 's'} retained.`,
          source_ids: proposal.source_ids,
          proposal_id: proposal.id,
        });
        if (proposal.items.length || proposal.conflicts.length) appendChange(current, {
          type: 'proposal_created', title: proposal.title, summary: proposal.summary,
          source_refs: proposal.items.flatMap((item) => item.source_refs), review_state: 'unreviewed', proposal_id: proposal.id,
        });
      }
    } else {
      for (const sourceId of batchSourceIds) {
        const source = current.sources.find((item) => item.id === sourceId);
        if (source) source.extraction_note = 'The model did not complete this batch. No segments were marked processed; retry will start here.';
      }
      appendAudit(current, { type: 'extraction_failed', summary: 'Model extraction did not complete. Sources are preserved and this batch remains available to retry.', source_ids: batchSourceIds });
      appendChange(current, { type: 'extraction_failed', title: 'Sources need review', summary: extraction.error || 'The model did not complete this batch.', source_refs: [], review_state: 'unresolved' });
    }
    refreshGraph(current);
  });
  const savedWorkspace = await store.getWorkspace(projectId);
  const processedSources = savedWorkspace?.sources.filter((source) => selected.some((item) => item.id === source.id)) || selected;
  const savedSources = savedWorkspace?.sources.filter((source) => visibleIds.has(source.id)) || reported;
  const finalProcessed = processedSources.reduce((sum, source) => sum + (source.processed_segments?.length || 0), 0);
  const finalTotal = processedSources.reduce((sum, source) => sum + (source.segments_total || 0), 0);
  const remaining = Math.max(0, finalTotal - finalProcessed);
  extraction.files = savedSources.map(fileResult);
  const finalParserLimited = savedSources.filter((source) => source.parser_status !== 'parsed' || source.parse_coverage !== 'complete').length;
  const coverageNotes = [
    remaining > 0 ? `${remaining} segment${remaining === 1 ? '' : 's'} remain in the saved source ledger.` : undefined,
    finalParserLimited > 0 ? 'Model coverage applies only to retained parsed text. Check parser coverage notes for omitted content or legacy text.' : undefined,
    !modelSucceeded ? extraction.error : undefined,
  ].filter((note): note is string => Boolean(note));
  extraction.coverage = {
    segments_sent: modelSucceeded ? batch.length : 0,
    total_segments: finalTotal,
    segments_remaining: remaining,
    complete: remaining === 0 && finalParserLimited === 0 && processedSources.length > 0,
    model_complete: remaining === 0,
    parser_complete: finalParserLimited === 0,
    parser_limited_sources: finalParserLimited,
    ...(coverageNotes.length ? { note: coverageNotes.join(' ') } : {}),
  };
  updateJob(jobId, {
    segments_total: finalTotal,
    segments_processed: finalProcessed,
    segments_remaining: remaining,
    progress: finalTotal ? Math.min(96, 20 + Math.floor((finalProcessed / finalTotal) * 72)) : 20,
    phase: modelSucceeded ? `Saved ${finalProcessed} of ${finalTotal} source segments` : 'Source batch remains available to retry',
  });
  return { sources: savedSources, extraction, proposal };
}

async function processDocuments(
  projectId: string,
  _kind: JobSnapshot['kind'],
  inputs: Array<{ name: string; relativePath?: string; mediaType: string; bytes: Buffer }>,
  jobId: string,
) {
  updateJob(jobId, { status: 'running', phase: `Parsing 0 of ${inputs.length} files`, progress: 8, files_total: inputs.length, files_processed: 0 });
  const parsed: ParsedSource[] = [];
  for (const [index, input] of inputs.entries()) {
    const sourceId = id();
    const safeName = safeNameForSource(input.name);
    const relativePath = safeRelativePath(input.relativePath, safeName);
    const source = await parseSource({ ...input, name: safeName, relativePath }, sourceId);
    parsed.push(source);
    const completedFiles = index + 1;
    const parsedFiles = parsed.filter((item) => item.status === 'parsed').length;
    updateJob(jobId, {
      phase: `Parsed ${completedFiles} of ${inputs.length} files`,
      progress: 8 + Math.floor((completedFiles / inputs.length) * 12),
      files_processed: completedFiles,
      files_parsed: parsedFiles,
      files_not_parsed: completedFiles - parsedFiles,
    });
  }
  const sources = await recordSources(projectId, parsed);
  const readableIds = sources.filter((source) => source.parser_status === 'parsed').map((source) => source.id);
  return processAllSourceCoverage(projectId, readableIds, jobId, 'ingest', sources.map((source) => source.id));
}

async function processSavedSources(projectId: string, requestedIds: string[] | undefined, jobId: string): Promise<IngestResult> {
  updateJob(jobId, { status: 'running', phase: 'Loading saved sources', progress: 12 });
  return processAllSourceCoverage(projectId, requestedIds?.length ? requestedIds : undefined, jobId, 'retry');
}

async function processProjectDiagnosis(projectId: string, jobId: string): Promise<IngestResult> {
  updateJob(jobId, { status: 'running', phase: 'Preparing source-grounded diagnosis', progress: 12 });
  const workspace = await store.getWorkspace(projectId);
  if (!workspace) throw new Error('Project not found.');
  const sources = workspace.sources.filter((source) => !source.fixture_only && source.parser_status === 'parsed');
  const documents = [];
  const sourcesWithoutText: ProjectSource[] = [];
  for (const source of sources) {
    const text = await store.getSourceText(source.id);
    if (!text?.trim()) {
      sourcesWithoutText.push(source);
      continue;
    }
    documents.push({ source_id: source.id, name: source.relative_path || source.name, text });
  }
  if (!documents.length) throw new Error('Add readable project sources before asking Codex for a diagnosis. Synthetic fixture sources are not sent as AI input.');

  updateJob(jobId, { phase: `Analysing ${documents.length} saved sources with Codex CLI`, progress: 32, files_total: documents.length, files_processed: documents.length });
  let extracted: ModelExtraction;
  try {
    extracted = await extractWithCodex(documents, allRecords(workspace), pendingProposalRecords(workspace), 'diagnosis');
  } catch (error) {
    if (error instanceof ProviderError && error.kind === 'unavailable') markProviderUnavailable();
    throw error;
  }
  const diagnosisRecordCount = extracted.records.length;
  extracted.records = extracted.records.filter((record) => (record.kind === 'risk' || record.kind === 'decision') && (record.description?.trim().length || 0) >= 24);
  if (extracted.records.length < diagnosisRecordCount) extracted.missing_info.push('Some risk or decision suggestions were omitted because they lacked a clear description.');
  if (sourcesWithoutText.length) extracted.missing_info.push(`${sourcesWithoutText.length} parsed source${sourcesWithoutText.length === 1 ? ' has' : 's have'} no retained text and were not included.`);
  const modelSources = sources.filter((source) => !sourcesWithoutText.includes(source));
  updateJob(jobId, { phase: 'Verifying citations and preparing manager review', progress: 78 });
  const latest = await store.getWorkspace(projectId);
  if (!latest) throw new Error('Project workspace is unavailable.');
  const mapped = mapPendingTargets(extracted, latest);
  let proposal: ProjectProposal | null = buildProposal(
    projectId,
    latest,
    modelSources,
    mapped,
    providerSnapshot().model || 'gpt-6-luna',
    pendingProposalRecords(latest),
  );
  const proposedDiagnosisRecordCount = proposal.items.length;
  const diagnosisConflictCount = proposal.conflicts.length;
  if (!proposal.items.length && !proposal.conflicts.length) proposal = null;

  if (proposal) {
    updateJob(jobId, { phase: 'Saving diagnosis for manager review', progress: 92 });
    await store.transact((state) => {
      const current = state.workspaces.find((entry) => entry.project.id === projectId);
      if (!current || !proposal) throw new Error('Project workspace is unavailable.');
      proposal = mergeProposalIntoPending(current, proposal);
      if (!current.proposals.some((item) => item.id === proposal!.id)) current.proposals.unshift(proposal);
      current.proposals = current.proposals.slice(0, 500);
      appendAudit(current, {
        type: 'proposal_created',
        summary: `Codex proposed ${proposedDiagnosisRecordCount} risk or decision record${proposedDiagnosisRecordCount === 1 ? '' : 's'} from ${documents.length} saved sources. No proposal was applied.`,
        source_ids: proposal.source_ids,
        proposal_id: proposal.id,
      });
      if (proposal.items.length || proposal.conflicts.length) appendChange(current, {
        type: 'proposal_created', title: 'Codex diagnosis ready for review', summary: proposal.summary,
        source_refs: proposal.items.flatMap((item) => item.source_refs), review_state: 'unreviewed', proposal_id: proposal.id,
      });
      refreshGraph(current);
    });
  }

  const parserLimitedSources = modelSources.filter((source) => source.parse_coverage !== 'complete').length
    + workspace.sources.filter((source) => !source.fixture_only && source.parser_status !== 'parsed').length;
  const missing = [...new Set([...(proposal?.missing_info || extracted.missing_info)])];
  return {
    sources: workspace.sources,
    proposal,
    extraction: {
      provider_mode: 'model',
      provider_model: providerSnapshot().model,
      files: workspace.sources.map(fileResult),
      records_proposed: proposedDiagnosisRecordCount,
      conflicts: diagnosisConflictCount,
      missing_info: missing,
      coverage: {
        segments_sent: documents.length,
        total_segments: documents.length,
        segments_remaining: 0,
        complete: parserLimitedSources === 0 && sourcesWithoutText.length === 0,
        model_complete: true,
        parser_complete: parserLimitedSources === 0 && sourcesWithoutText.length === 0,
        parser_limited_sources: parserLimitedSources + sourcesWithoutText.length,
        ...((parserLimitedSources || sourcesWithoutText.length) ? { note: 'Codex reviewed the saved readable text. Source parsing and ordinary extraction coverage were not changed by this diagnosis pass.' } : {}),
      },
    },
  };
}

async function processAllSourceCoverage(
  projectId: string,
  requestedIds: string[] | undefined,
  jobId: string,
  action: 'ingest' | 'retry',
  reportIds?: string[],
): Promise<IngestResult> {
  const segmentBudget = jobs.get(jobId)?.segment_budget || DEFAULT_JOB_SEGMENT_BUDGET;
  let remainingBudget = segmentBudget;
  let segmentsSent = 0;
  let result: IngestResult | undefined;
  while (true) {
    const current = await processSourceCoverage(
      projectId,
      requestedIds,
      jobId,
      action,
      reportIds,
      Math.min(SEGMENTS_PER_PROVIDER_REQUEST, remainingBudget),
    );
    result = current;
    const sent = current.extraction.coverage?.segments_sent || 0;
    segmentsSent += sent;
    remainingBudget -= sent;
    if (current.extraction.coverage) current.extraction.coverage.segments_sent = segmentsSent;
    if (current.extraction.error || current.extraction.coverage?.complete || !current.extraction.coverage?.segments_remaining || sent === 0) break;
    if (remainingBudget <= 0) {
      current.extraction.coverage.budget_exhausted = true;
      const note = `The automatic job limit of ${segmentBudget} successfully processed text segments was reached. Start a new retry job to continue from the saved ledger.`;
      current.extraction.coverage.note = [current.extraction.coverage.note, note].filter(Boolean).join(' ');
      current.extraction.missing_info = [...new Set([...current.extraction.missing_info, note])];
      updateJob(jobId, { phase: 'Automatic segment budget reached', progress: 98 });
      break;
    }
  }
  if (!result) throw new Error('No processing result was produced.');
  return result;
}

function currentRecord(workspace: ProjectWorkspace, kind: ProjectRecord['kind'], recordId: string) {
  return getRecordArray(workspace, kind).find((record) => record.id === recordId);
}

function replacePlaceholderDependencies(workspace: ProjectWorkspace) {
  resolveDependencyPlaceholders(workspace);
  return resolveOwnerPlaceholders(workspace);
}

function auditOwnerLinkResolutions(workspace: ProjectWorkspace, changes: ReturnType<typeof resolveOwnerPlaceholders>) {
  for (const change of changes) {
    const member = change.after_owner_id ? workspace.members.find((candidate) => candidate.id === change.after_owner_id) : undefined;
    appendAudit(workspace, {
      type: 'record_edited',
      summary: member
        ? `Resolved ${change.title} owner link to ${member.title}.`
        : `Cleared an unmatched owner link for ${change.title}; kept the owner label ${change.owner || 'unknown'}.`,
      before: { owner_id: change.before_owner_id },
      after: { owner: change.owner, owner_id: change.after_owner_id },
      source_ids: change.source_refs.map((ref) => ref.source_id),
      record_id: change.record_id,
    });
    appendChange(workspace, {
      type: 'owner_assignment_resolved',
      title: member ? `Owner linked: ${change.title}` : `Owner link needs review: ${change.title}`,
      summary: member ? `The source-backed owner label now links to ${member.title}.` : 'No selected member record matched this owner label; the text remains on the work item.',
      source_refs: change.source_refs,
      review_state: member ? 'manager_confirmed' : 'unresolved',
    });
  }
}

function syncAcceptedProposalOwnerFields(workspace: ProjectWorkspace) {
  for (const proposal of workspace.proposals) {
    for (const item of proposal.items) {
      if (item.review_state !== 'manager_confirmed' || !item.record_id || !String(item.fields.owner_id || '').startsWith('candidate:member:')) continue;
      const record = currentRecord(workspace, item.record_kind, item.record_id);
      if (!record) continue;
      const before = item.fields.owner_id;
      item.fields.owner_id = record.owner_id || null;
      item.fields.field_refs = record.field_refs;
      appendAudit(workspace, {
        type: 'record_edited',
        summary: `Canonicalized the accepted owner link for ${record.title}.`,
        before: { proposal_item_owner_id: before },
        after: { proposal_item_owner_id: item.fields.owner_id },
        source_ids: record.field_refs?.owner?.map((ref) => ref.source_id) || [],
        proposal_id: proposal.id,
        record_id: record.id,
      });
    }
  }
}

function quarantineBaselineOnlyApproval(workspace: ProjectWorkspace) {
  for (const proposal of workspace.proposals) {
    for (const item of holdBaselineApprovalStatuses(proposal)) {
      const refs = item.source_refs;
      appendAudit(workspace, {
        type: 'proposal_item_held',
        summary: `Held ${item.title}: the source approves a baseline date but does not state approved delivery status.`,
        source_ids: refs.map((ref) => ref.source_id),
        proposal_id: proposal.id,
      });
      appendChange(workspace, {
        type: 'proposal_item_held',
        title: `Status held for review: ${item.title}`,
        summary: 'The approved-baseline wording does not establish approved work status.',
        source_refs: refs,
        review_state: 'unresolved',
        proposal_id: proposal.id,
      });
    }
  }
}

function normalizeWorkspaceForReview(workspace: ProjectWorkspace) {
  quarantineBaselineOnlyApproval(workspace);
  for (const proposal of workspace.proposals) labelPriorBatchDiagnostics(proposal);
  for (const repair of normalizePendingProposalItems(workspace)) {
    appendAudit(workspace, {
      type: 'proposal_item_merged',
      summary: `Merged duplicate pending item ${repair.merged_item_id} into ${repair.kept_item_id}: ${repair.title}. The items shared an exact source quote and compatible claims.`,
      before: repair.before,
      after: repair.after,
      source_ids: [...new Set(repair.after.source_refs.map((ref) => ref.source_id))],
      proposal_id: repair.proposal_id,
    });
  }
  const ownerChanges = resolveOwnerPlaceholders(workspace);
  auditOwnerLinkResolutions(workspace, ownerChanges);
  syncAcceptedProposalOwnerFields(workspace);
  refreshGraph(workspace);
}

function readFileRelativePaths(request: Request) {
  const value = request.body?.relative_paths;
  if (Array.isArray(value)) return value.map((item) => String(item));
  if (typeof value === 'string') return [value];
  return [];
}

function routeParam(request: Request, name: string) {
  const value = request.params[name];
  return Array.isArray(value) ? value[0] || '' : value || '';
}

function projectOr404(projectId: string) {
  return store.getWorkspace(projectId);
}

function matchingPositions(text: string, quote: string, limit = 101) {
  const positions: number[] = [];
  let offset = 0;
  while (positions.length < limit) {
    const found = text.indexOf(quote, offset);
    if (found < 0) break;
    positions.push(found);
    offset = found + Math.max(1, quote.length);
  }
  return { positions, capped: positions.length === limit };
}

function quoteContext(text: string, quote: string, location: string) {
  const { positions, capped } = matchingPositions(text, quote);
  let selected: number | undefined;
  let ambiguous = positions.length > 1;
  const locator = location.match(/\b(line|row|page)\s+(\d+)\b/i);
  if (positions.length && locator) {
    const marker = `${locator[1]} ${locator[2]}`.toLocaleLowerCase();
    const anchors = [...text.matchAll(/\[([^\]]+)\]/g)]
      .filter((match) => match[1]?.toLocaleLowerCase().includes(marker))
      .map((match) => match.index || 0);
    if (anchors.length) {
      const ranked = positions.map((position) => ({ position, distance: Math.min(...anchors.map((anchor) => Math.abs(position - anchor))) }))
        .sort((left, right) => left.distance - right.distance);
      selected = ranked[0]?.position;
      ambiguous = ranked.length > 1 && ranked[0].distance === ranked[1].distance;
    }
  }
  if (selected === undefined && positions.length) selected = positions[0];
  const contextLimit = 2_048;
  const contextPadding = Math.floor((contextLimit - quote.length) / 2);
  const start = selected === undefined ? 0 : Math.max(0, selected - contextPadding);
  const end = selected === undefined ? Math.min(text.length, contextLimit) : Math.min(text.length, selected + quote.length + contextPadding);
  return {
    excerpt: text.slice(start, end),
    excerpt_start: start,
    total_characters: text.length,
    match_start: selected ?? null,
    match_end: selected === undefined ? null : selected + quote.length,
    match_count: Math.min(positions.length, 100),
    match_count_capped: capped,
    exact_match: positions.length > 0,
    ambiguous: positions.length === 0 ? false : ambiguous,
  };
}

app.get('/api/health', async (_request, response) => {
  response.json({ status: 'ok', api: 'ready', provider: providerSnapshot() });
});

app.get('/api/provider', (_request, response) => {
  response.json(providerSnapshot());
});

app.get('/api/projects/:projectId/export', async (request, response, next) => {
  try {
    const workspace = await projectOr404(routeParam(request, 'projectId'));
    if (!workspace) return response.status(404).json({ error: 'Project not found.' });
    const format = String(request.query.format || 'json');
    if (format !== 'json' && format !== 'markdown') return response.status(400).json({ error: 'Choose json or markdown export format.' });
    refreshGraph(workspace);
    const file = buildProjectExport(workspace, format);
    response.setHeader('Content-Type', file.contentType);
    response.setHeader('Content-Disposition', `attachment; filename="${file.fileName}"`);
    response.send(file.content);
  } catch (error) { next(error); }
});

app.get('/api/projects', async (_request, response, next) => {
  try {
    const workspaces = await store.listWorkspaces();
    response.json({ projects: workspaces.map((workspace) => workspace.project).sort((a, b) => b.updated_at.localeCompare(a.updated_at)) });
  } catch (error) { next(error); }
});

app.post('/api/projects', async (request, response, next) => {
  try {
    const parsed = z.object({ name: z.string().trim().min(1).max(150) }).safeParse(request.body);
    if (!parsed.success) return response.status(400).json({ error: 'Enter a project name up to 150 characters.' });
    const workspace = newWorkspace(parsed.data.name);
    appendAudit(workspace, { type: 'project_created', summary: `Project created: ${workspace.project.name}` });
    await store.transact((state) => { state.workspaces.unshift(workspace); });
    response.status(201).json({ project: workspace.project });
  } catch (error) { next(error); }
});

app.post('/api/projects/demo', async (_request, response, next) => {
  try {
    const timestamp = now();
    const workspace = buildSyntheticDemoWorkspace(id(), timestamp);
    refreshGraph(workspace);
    await store.transact((state) => {
      state.workspaces.unshift(workspace);
      for (const source of workspace.sources) state.sourceTexts[source.id] = source.excerpt || '';
    });
    response.status(201).json({ project: workspace.project });
  } catch (error) { next(error); }
});

app.post('/api/projects/demo-ai', async (_request, response, next) => {
  try {
    const workspace = newWorkspace('Iluminat stradal · laborator AI', true);
    workspace.project.description = 'Laborator sintetic pentru Codex CLI. Include doar material demonstrativ, fără documente sau date de client.';
    appendAudit(workspace, { type: 'project_created', summary: 'Synthetic street-lighting AI intake workspace created.' });
    await store.transact((state) => { state.workspaces.unshift(workspace); });
    response.status(201).json({ project: workspace.project });
  } catch (error) { next(error); }
});

app.get('/api/projects/:projectId/agent-context', async (request, response, next) => {
  try {
    const workspace = await projectOr404(routeParam(request, 'projectId'));
    if (!workspace) return response.status(404).json({ error: 'Project not found.' });
    response.json(await getProjectContext(workspace));
  } catch (error) { next(error); }
});

app.post('/api/projects/:projectId/agent-proposals', async (request, response, next) => {
  try {
    let result: Awaited<ReturnType<typeof proposeProjectChanges>> | undefined;
    await store.transact(async state => {
      const workspace = state.workspaces.find(value => value.project.id === routeParam(request, 'projectId'));
      if (!workspace) return;
      const sourceTexts: Record<string, string> = {};
      for (const source of workspace.sources) sourceTexts[source.id] = await store.getSourceText(source.id) ?? source.excerpt ?? '';
      result = await proposeProjectChanges(workspace, request.body, request.header('Idempotency-Key') || '', sourceTexts);
    });
    if (!result) return response.status(404).json({ error: 'Project not found.' });
    response.status(result.replayed ? 200 : 201).json(result);
  } catch (error) { response.status(409).json({ error: error instanceof Error ? error.message.slice(0, 500) : 'Proposal rejected.' }); }
});

app.post('/api/projects/:projectId/scenarios', async (request, response, next) => {
  try {
    const workspace = await projectOr404(routeParam(request, 'projectId'));
    if (!workspace) return response.status(404).json({ error: 'Project not found.' });
    const config = request.body?.config || createDefaultSimulationConfig(workspace);
    const result = await runSimulation(workspace, config);
    response.json(result);
  } catch (error) { response.status(400).json({ error: error instanceof Error ? error.message.slice(0, 500) : 'Invalid scenario.' }); }
});

app.get('/api/projects/:projectId/workspace', async (request, response, next) => {
  try {
    const projectId = routeParam(request, 'projectId');
    await store.transact((state) => {
      const persisted = state.workspaces.find((candidate) => candidate.project.id === projectId);
      if (persisted) normalizeWorkspaceForReview(persisted);
    });
    const workspace = await projectOr404(projectId);
    if (!workspace) return response.status(404).json({ error: 'Project not found.' });
    refreshGraph(workspace);
    response.json(workspace);
  } catch (error) { next(error); }
});

app.get('/api/projects/:projectId/events', async (request, response, next) => {
  try {
    const projectId = routeParam(request, 'projectId');
    const workspace = await projectOr404(projectId);
    if (!workspace) return response.status(404).json({ error: 'Project not found.' });
    const parsedLimit = request.query.limit === undefined ? 100 : Number(request.query.limit);
    if (!Number.isInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > 200) return response.status(400).json({ error: 'Event page size must be between 1 and 200.' });
    const events = [
      ...workspace.audit.map((item) => ({ ...item, event_kind: 'audit' as const })),
      ...workspace.changes.map((item) => ({ ...item, event_kind: 'change' as const })),
    ].sort((left, right) => left.at.localeCompare(right.at) || left.id.localeCompare(right.id));
    const cursor = typeof request.query.after === 'string' ? request.query.after : '';
    let start = 0;
    if (cursor) {
      const cursorIndex = events.findIndex((event) => event.id === cursor);
      if (cursorIndex < 0) return response.status(410).json({ error: 'The event cursor is outside the retained project history. Read the current workspace and start a new cursor.' });
      start = cursorIndex + 1;
    }
    const page = events.slice(start, start + parsedLimit);
    response.json({ events: page, next_cursor: page.at(-1)?.id || cursor || null, has_more: start + page.length < events.length });
  } catch (error) { next(error); }
});

app.get('/api/projects/:projectId/jobs/:jobId', async (request, response, next) => {
  try {
    const projectId = routeParam(request, 'projectId');
    if (!await projectOr404(projectId)) return response.status(404).json({ error: 'Project not found.' });
    const jobId = routeParam(request, 'jobId');
    const job = jobs.get(jobId) || await store.getJob(jobId);
    if (!job || job.project_id !== projectId) return response.status(404).json({ error: 'Processing job not found in this project.' });
    response.json({ job });
  } catch (error) { next(error); }
});

app.get('/api/projects/:projectId/jobs/:jobId/events', async (request, response, next) => {
  try {
    const projectId = routeParam(request, 'projectId');
    if (!await projectOr404(projectId)) return response.status(404).json({ error: 'Project not found.' });
    const jobId = routeParam(request, 'jobId');
    const job = jobs.get(jobId) || await store.getJob(jobId);
    if (!job || job.project_id !== projectId) return response.status(404).json({ error: 'Processing job not found in this project.' });
    const after = request.query.after === undefined ? 0 : Number(request.query.after);
    if (!Number.isSafeInteger(after) || after < 0) return response.status(400).json({ error: 'Event sequence must be a non-negative integer.' });
    const events = (job.events || []).filter((event) => event.sequence > after);
    response.json({ job_id: job.id, events, next_sequence: events.at(-1)?.sequence || after, has_more: false });
  } catch (error) { next(error); }
});

app.get('/api/projects/:projectId/sources/:sourceId/quote', async (request, response, next) => {
  try {
    const projectId = routeParam(request, 'projectId');
    const sourceId = routeParam(request, 'sourceId');
    const workspace = await projectOr404(projectId);
    if (!workspace) return response.status(404).json({ error: 'Project not found.' });
    const source = workspace.sources.find((item) => item.id === sourceId);
    if (!source) return response.status(404).json({ error: 'Source not found in this project.' });
    const quote = typeof request.query.quote === 'string' ? request.query.quote.trim() : '';
    const location = typeof request.query.location === 'string' ? request.query.location.slice(0, 500) : '';
    if (quote.length < 4 || quote.length > 2_048) return response.status(400).json({ error: 'Provide an exact source quote between 4 and 2,048 characters.' });
    const text = await store.getSourceText(sourceId);
    if (text === undefined) return response.status(422).json({ error: 'Parsed source text is unavailable. Re-upload the source to open its evidence.' });
    const context = quoteContext(text, quote, location);
    response.json({
      source_id: source.id,
      location,
      ...context,
      parse_coverage: source.parse_coverage,
      extraction_coverage: source.extraction_coverage,
      coverage_note: source.coverage_note,
      extraction_note: source.extraction_note,
    });
  } catch (error) { next(error); }
});

app.post('/api/projects/:projectId/ingest', requireRequestKey, upload.array('files', UPLOAD_LIMIT), async (request, response, next) => {
  try {
    const projectId = routeParam(request, 'projectId');
    const workspace = await projectOr404(projectId);
    if (!workspace) return response.status(404).json({ error: 'Project not found.' });
    const key = requestKey(request, response);
    if (!key) return;
    const files = (request.files || []) as Express.Multer.File[];
    if (!files.length) return response.status(400).json({ error: 'Choose at least one file to upload.' });
    const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
    if (totalBytes > MAX_UPLOAD_BYTES) return response.status(413).json({ error: 'This upload is larger than the local processing limit. Split the files into smaller groups.' });
    const relativePaths = readFileRelativePaths(request);
    const inputs = files.map((file, index) => ({
      name: safeNameForSource(file.originalname),
      relativePath: relativePaths[index] ? safeRelativePath(relativePaths[index], safeNameForSource(file.originalname)) : safeNameForSource(file.originalname),
      mediaType: file.mimetype,
      bytes: file.buffer,
    }));
    const sourceFingerprint = fingerprint(JSON.stringify(inputs.map((input) => ({
      name: input.name,
      path: input.relativePath,
      media_type: input.mediaType,
      sha256: createHash('sha256').update(input.bytes).digest('hex'),
    }))));
    const created = await createJob(projectId, 'ingest', {
      scope: `project:${projectId}:ingest`, key, fingerprint: sourceFingerprint,
    }, (jobId) => processDocuments(projectId, 'ingest', inputs, jobId));
    sendJobCreation(response, created);
  } catch (error) { next(error); }
});

app.post('/api/projects/:projectId/checkins', async (request, response, next) => {
  try {
    const projectId = routeParam(request, 'projectId');
    const workspace = await projectOr404(projectId);
    if (!workspace) return response.status(404).json({ error: 'Project not found.' });
    const key = requestKey(request, response);
    if (!key) return;
    const parsed = z.object({ text: z.string().trim().min(1).max(80_000), sourceName: z.string().trim().max(160).optional() }).safeParse(request.body);
    if (!parsed.success) return response.status(400).json({ error: 'Add update text under 80,000 characters.' });
    const safeName = checkinSourceName(parsed.data.sourceName || `Check-in ${new Date().toISOString().slice(0, 10)}.txt`);
    const bytes = Buffer.from(parsed.data.text, 'utf8');
    const bodyFingerprint = fingerprint(JSON.stringify({ text: parsed.data.text, sourceName: safeName }));
    const created = await createJob(projectId, 'checkin', {
      scope: `project:${projectId}:checkin`, key, fingerprint: bodyFingerprint,
    }, (jobId) => processDocuments(projectId, 'checkin', [{ name: safeName, relativePath: safeName, mediaType: 'text/plain', bytes }], jobId));
    sendJobCreation(response, created);
  } catch (error) { next(error); }
});

app.post('/api/projects/:projectId/diagnosis', async (request, response, next) => {
  try {
    const projectId = routeParam(request, 'projectId');
    const workspace = await projectOr404(projectId);
    if (!workspace) return response.status(404).json({ error: 'Project not found.' });
    const key = requestKey(request, response);
    if (!key) return;
    const parsed = z.object({}).strict().safeParse(request.body || {});
    if (!parsed.success) return response.status(400).json({ error: 'Diagnosis accepts no client-supplied source content. Upload sources to this project first.' });
    const sources = workspace.sources.filter((source) => !source.fixture_only && source.parser_status === 'parsed');
    if (!sources.length) return response.status(422).json({ error: 'Add readable source files before generating an AI diagnosis. The prepared visual example is not sent to Codex.' });
    const created = await createJob(projectId, 'diagnosis', {
      scope: `project:${projectId}:diagnosis`, key, fingerprint: fingerprint(JSON.stringify({ sources: sources.map((source) => source.id).sort() })),
    }, (jobId) => processProjectDiagnosis(projectId, jobId));
    sendJobCreation(response, created);
  } catch (error) { next(error); }
});

app.post('/api/projects/:projectId/sources/retry', async (request, response, next) => {
  try {
    const projectId = routeParam(request, 'projectId');
    const workspace = await projectOr404(projectId);
    if (!workspace) return response.status(404).json({ error: 'Project not found.' });
    const key = requestKey(request, response);
    if (!key) return;
    const parsed = z.object({
      sourceIds: z.array(z.string().uuid()).max(100).optional(),
      reprocess: z.boolean().optional(),
    }).strict().safeParse(request.body || {});
    if (!parsed.success) return response.status(400).json({ error: 'The source list is invalid.' });
    if (parsed.data.reprocess && !parsed.data.sourceIds?.length) return response.status(400).json({ error: 'Choose specific source IDs before requesting reanalysis.' });
    if (parsed.data.sourceIds?.length) {
      const known = new Set(workspace.sources.map((source) => source.id));
      if (parsed.data.sourceIds.some((sourceId) => !known.has(sourceId))) return response.status(400).json({ error: 'One or more sources are not part of this project.' });
    }
    if (parsed.data.reprocess) {
      const selected = workspace.sources.filter((source) => parsed.data.sourceIds!.includes(source.id));
      if (selected.some((source) => source.fixture_only || (source.parser_status !== 'parsed' && !(source.parser_status === 'failed' && canReparseSource(source))))) {
        return response.status(400).json({ error: 'Choose parsed sources or supported failed files. Synthetic fixture sources cannot be reanalyzed.' });
      }
    }
    const sourceIds = parsed.data.sourceIds ? [...parsed.data.sourceIds].sort() : undefined;
    const bodyFingerprint = fingerprint(JSON.stringify({ sourceIds: sourceIds || 'all', reprocess: parsed.data.reprocess === true }));
    const prepare = async () => {
      await store.transact((state) => {
        const current = state.workspaces.find((item) => item.project.id === projectId);
        if (!current) return;
        if (parsed.data.reprocess) {
          for (const sourceId of sourceIds || []) {
            const source = current.sources.find((item) => item.id === sourceId);
            if (!source) continue;
            source.processed_segments = [];
            source.extraction_coverage = source.parser_status === 'parsed' ? 'pending' : 'unavailable';
            source.extraction_note = 'Manager explicitly requested source reanalysis. Existing proposals, decisions, and audit history are retained.';
          }
        }
        appendAudit(current, {
          type: 'extraction_retry',
          summary: parsed.data.reprocess
            ? `Manager requested reanalysis of ${sourceIds!.length} source${sourceIds!.length === 1 ? '' : 's'}. Earlier proposals, decisions, and audit history were retained.`
            : `Manager requested retry for ${sourceIds?.length || 'all'} saved source${sourceIds?.length === 1 ? '' : 's'}. Successful segments will be skipped.`,
          source_ids: sourceIds,
        });
      });
    };
    const created = await createJob(projectId, 'retry', {
      scope: `project:${projectId}:sources:retry`, key, fingerprint: bodyFingerprint,
    }, (jobId) => processSavedSources(projectId, sourceIds, jobId), prepare);
    sendJobCreation(response, created);
  } catch (error) { next(error); }
});

app.get('/api/jobs/:jobId', async (request, response, next) => {
  try {
    const key = routeParam(request, 'jobId');
    const job = jobs.get(key) || await store.getJob(key);
  if (!job) return response.status(404).json({ error: 'Processing job not found. Start the upload or check-in again.' });
  response.json({ job });
  } catch (error) { next(error); }
});

app.post('/api/projects/:projectId/proposals/:proposalId/items/:itemId/review', async (request, response, next) => {
  try {
    const parsed = itemReviewSchema.safeParse(request.body);
    if (!parsed.success) return response.status(400).json({ error: 'Alege acțiunea, câmpurile și motivul corecției.' });
    let result: ReturnType<typeof reviewProposalItem> | undefined;
    let reviewError = '';
    await store.transact(state => {
      const workspace = state.workspaces.find(value => value.project.id === routeParam(request, 'projectId'));
      if (!workspace) return;
      try { result = reviewProposalItem(workspace, routeParam(request, 'proposalId'), routeParam(request, 'itemId'), parsed.data); }
      catch (error) {
        if (error instanceof DependencyCycleError) throw error;
        reviewError = error instanceof Error ? error.message : 'Propunere invalidă.';
      }
    });
    if (!result) return response.status(409).json({ error: reviewError || 'Proiectul lipsește.' });
    response.json(result);
  } catch (error) {
    if (error instanceof DependencyCycleError) return response.status(409).json({ error: error.message, cycle: error.cycle });
    next(error);
  }
});

app.post('/api/projects/:projectId/proposals/:proposalId/apply', async (request, response, next) => {
  try {
    const body = z.object({ itemIds: z.array(z.string().uuid()).min(1).max(200) }).strict().safeParse(request.body || {});
    if (!body.success) return response.status(400).json({ error: 'Choose one or more valid proposal item IDs.' });
    const requestedItemIds = new Set(body.data.itemIds);
    let result: {
      proposal?: ProjectProposal; graph?: ProjectWorkspace['graph']; applied: number; conflicts_remaining: number;
      applied_item_ids: string[]; remaining_item_ids: string[]; stale?: boolean; statusCode?: number; error?: string;
    } | undefined;
    await store.transact((state) => {
      const workspace = state.workspaces.find((candidate) => candidate.project.id === routeParam(request, 'projectId'));
      if (!workspace) return;
      normalizeWorkspaceForReview(workspace);
      const proposal = workspace.proposals.find((candidate) => candidate.id === routeParam(request, 'proposalId'));
      if (!proposal) return;
      if (requestedItemIds) {
        const known = new Map(proposal.items.map((item) => [item.id, item]));
        if ([...requestedItemIds].some((itemId) => !known.has(itemId))) {
          result = { proposal, graph: workspace.graph, applied: 0, conflicts_remaining: proposal.conflicts.length, applied_item_ids: [], remaining_item_ids: proposal.items.filter((item) => item.review_state !== 'manager_confirmed').map((item) => item.id), statusCode: 400, error: 'One or more selected item IDs do not belong to this proposal.' };
          return;
        }
        if ([...requestedItemIds].some((itemId) => {
          const item = known.get(itemId)!;
          return item.conflict || item.stale;
        })) {
          result = { proposal, graph: workspace.graph, applied: 0, conflicts_remaining: proposal.conflicts.length, applied_item_ids: [], remaining_item_ids: proposal.items.filter((item) => item.review_state !== 'manager_confirmed').map((item) => item.id), statusCode: 400, error: 'Resolve conflicted or stale items before selecting them.' };
          return;
        }
      }
      if (proposal.status !== 'proposed') {
        result = { proposal, graph: workspace.graph, applied: 0, conflicts_remaining: proposal.conflicts.length, applied_item_ids: [], remaining_item_ids: proposal.items.filter((item) => item.review_state !== 'manager_confirmed').map((item) => item.id) };
        return;
      }
      const staleItems: Array<{ item: ProjectProposal['items'][number]; field: string; currentValue: unknown; currentRefs: SourceRef[] }> = [];
      for (const item of proposal.items) {
        if (requestedItemIds && !requestedItemIds.has(item.id)) continue;
        if (item.conflict || item.review_state === 'manager_confirmed') continue;
        if (item.operation === 'create') {
          const duplicate = getRecordArray(workspace, item.record_kind).find((record) => normalizedKey(record.title) === normalizedKey(item.title));
          if (duplicate) staleItems.push({ item, field: 'record_exists', currentValue: duplicate.title, currentRefs: [] });
          continue;
        }
        const record = item.record_id ? currentRecord(workspace, item.record_kind, item.record_id) : undefined;
        if (!record) {
          staleItems.push({ item, field: 'record_removed', currentValue: null, currentRefs: [] });
          continue;
        }
        if (normalizedKey(record.title) !== normalizedKey(item.before?.title || item.title)) {
          staleItems.push({ item, field: 'title', currentValue: record.title, currentRefs: record.source_refs });
        }
        for (const field of Object.keys(item.fields)) {
          const beforeValue = (item.before as Record<string, unknown> | null)?.[field];
          const currentValue = (record as unknown as Record<string, unknown>)[field];
          if (JSON.stringify(beforeValue ?? null) !== JSON.stringify(currentValue ?? null)) {
            staleItems.push({ item, field, currentValue, currentRefs: record.field_refs?.[field] || [] });
          }
        }
      }
      if (staleItems.length) {
        for (const stale of staleItems) {
          stale.item.conflict = true;
          stale.item.stale = true;
          stale.item.review_state = 'unresolved';
          if (!proposal.conflicts.some((conflict) => conflict.record_title === stale.item.title && conflict.field === `workspace_changed:${stale.field}`)) {
            proposal.conflicts.push({
              field: `workspace_changed:${stale.field}`,
              record_title: stale.item.title,
              claims: [
                { value: stale.currentValue === null ? null : String(stale.currentValue), source_refs: stale.currentRefs },
                { value: String((stale.item.fields as Record<string, unknown>)[stale.field] ?? ''), source_refs: stale.item.fields.field_refs?.[stale.field] || stale.item.source_refs },
              ],
            });
          }
        }
        proposal.summary = 'The live project changed after this proposal was prepared. Review the conflict before applying it.';
        appendAudit(workspace, { type: 'proposal_stale', summary: proposal.summary, source_ids: proposal.source_ids, proposal_id: proposal.id });
        appendChange(workspace, { type: 'proposal_stale', title: proposal.title, summary: proposal.summary, source_refs: proposal.items.flatMap((item) => item.source_refs), review_state: 'unresolved', proposal_id: proposal.id });
        refreshGraph(workspace);
        result = { proposal, graph: workspace.graph, applied: 0, conflicts_remaining: proposal.conflicts.length, applied_item_ids: [], remaining_item_ids: proposal.items.filter((item) => item.review_state !== 'manager_confirmed').map((item) => item.id), stale: true };
        return;
      }
      const dependencyOverrides: Record<string, readonly string[]> = {};
      for (const item of proposal.items) {
        if (!requestedItemIds.has(item.id) || item.conflict || item.stale || item.review_state === 'manager_confirmed' || !item.record_id || !item.fields.depends_on) continue;
        if (item.record_kind === 'task' || item.record_kind === 'deliverable') dependencyOverrides[item.record_id] = item.fields.depends_on;
      }
      if (Object.keys(dependencyOverrides).length) assertTaskDependencyAcyclic([...workspace.tasks, ...workspace.deliverables], dependencyOverrides);
      const beforeRecords = new Map(allRecords(workspace).map((record) => [record.id, structuredClone(record)]));
      let applied = 0;
      const appliedItemIds: string[] = [];
      const orderedItems = [...proposal.items].sort((left, right) => {
        const leftMemberCreate = left.operation === 'create' && left.record_kind === 'member' ? 1 : 0;
        const rightMemberCreate = right.operation === 'create' && right.record_kind === 'member' ? 1 : 0;
        return rightMemberCreate - leftMemberCreate;
      });
      for (const item of orderedItems) {
        if (requestedItemIds && !requestedItemIds.has(item.id)) continue;
        if (item.conflict || item.review_state === 'manager_confirmed') continue;
        let record: ProjectRecord | undefined;
        if (item.operation === 'create') {
          record = newProjectRecord({
            ...item.fields,
            id: id(),
            kind: item.record_kind,
            title: item.title,
            review_state: 'manager_confirmed',
            evidence_state: item.fields.evidence_state || 'supported',
            source_refs: item.source_refs,
          });
          addStoredRecord(workspace, record);
          item.record_id = record.id;
          item.operation = 'update';
        } else if (item.record_id) {
          record = currentRecord(workspace, item.record_kind, item.record_id);
          if (!record) continue;
          const before = structuredClone(record);
          const appliedFields = { ...item.fields };
          if (item.fields.field_refs) appliedFields.field_refs = { ...(record.field_refs || {}), ...item.fields.field_refs };
          Object.assign(record, appliedFields, { review_state: 'manager_confirmed', updated_at: now() });
          item.before = Object.fromEntries(Object.keys(item.fields).map((field) => [field, (before as unknown as Record<string, unknown>)[field]]));
        }
        if (!record) continue;
        item.review_state = 'manager_confirmed';
        appendAudit(workspace, {
          type: 'proposal_applied',
          summary: `${item.operation === 'update' ? 'Applied' : 'Added'} ${item.record_kind}: ${item.title}`,
          before: beforeRecords.get(record.id) || item.before,
          after: structuredClone(record),
          source_ids: item.source_refs.map((ref) => ref.source_id),
          proposal_id: proposal.id,
          record_id: record.id,
        });
        appendChange(workspace, {
          type: 'proposal_applied',
          title: `${item.record_kind}: ${item.title}`,
          summary: `Manager applied a source-grounded update from ${proposal.title}.`,
          source_refs: item.source_refs,
          review_state: 'manager_confirmed',
          proposal_id: proposal.id,
        });
        applied += 1;
        appliedItemIds.push(item.id);
      }
      const ownerLinkChanges = replacePlaceholderDependencies(workspace);
      auditOwnerLinkResolutions(workspace, ownerLinkChanges);
      syncAcceptedProposalOwnerFields(workspace);
      if (Object.keys(dependencyOverrides).length || ownerLinkChanges.length) assertTaskDependencyAcyclic([...workspace.tasks, ...workspace.deliverables]);
      const unresolvedItems = proposal.conflicts.length > 0 || proposal.items.some((item) => item.conflict || item.review_state !== 'manager_confirmed');
      if (!unresolvedItems) {
        proposal.status = 'applied';
        proposal.decided_at = now();
      }
      proposal.summary = unresolvedItems
        ? `${applied} non-conflicting change${applied === 1 ? '' : 's'} applied. Resolve the remaining conflict${proposal.conflicts.length === 1 ? '' : 's'} before applying those fields.`
        : `Manager applied ${applied} source-grounded change${applied === 1 ? '' : 's'}.`;
      appendAudit(workspace, {
        type: 'proposal_applied',
        summary: proposal.summary,
        source_ids: proposal.source_ids,
        proposal_id: proposal.id,
      });
      refreshGraph(workspace);
      result = {
        proposal, graph: workspace.graph, applied, conflicts_remaining: proposal.conflicts.length,
        applied_item_ids: appliedItemIds,
        remaining_item_ids: proposal.items.filter((item) => item.review_state !== 'manager_confirmed').map((item) => item.id),
      };
    });
    if (!result) return response.status(404).json({ error: 'Proposal not found.' });
    if (result.statusCode) return response.status(result.statusCode).json({ ...result, error: result.error });
    if (result.stale) return response.status(409).json({ ...result, error: result.proposal?.summary || 'The live project changed after this proposal was prepared.' });
    response.json(result);
  } catch (error) {
    if (error instanceof DependencyCycleError) return response.status(409).json({ error: error.message, cycle: error.cycle });
    next(error);
  }
});

app.post('/api/projects/:projectId/proposals/:proposalId/reject', async (request, response, next) => {
  try {
    const body = z.object({ reason: z.string().trim().max(1_000).optional() }).safeParse(request.body || {});
    if (!body.success) return response.status(400).json({ error: 'The rejection reason is too long.' });
    let proposal: ProjectProposal | undefined;
    await store.transact((state) => {
      const workspace = state.workspaces.find((candidate) => candidate.project.id === routeParam(request, 'projectId'));
      if (!workspace) return;
      proposal = workspace.proposals.find((candidate) => candidate.id === routeParam(request, 'proposalId'));
      if (!proposal) return;
      if (proposal.status === 'proposed') {
        proposal.status = 'rejected';
        proposal.decided_at = now();
        proposal.decision_reason = body.data.reason;
        for (const item of proposal.items) {
          if (item.review_state !== 'manager_confirmed') item.review_state = 'unresolved';
        }
        appendAudit(workspace, { type: 'proposal_rejected', summary: `Manager rejected: ${proposal.title}${body.data.reason ? ` (${body.data.reason})` : ''}`, source_ids: proposal.source_ids, proposal_id: proposal.id });
        appendChange(workspace, { type: 'proposal_rejected', title: proposal.title, summary: 'Manager rejected the proposed update. Live records were left unchanged.', source_refs: proposal.items.flatMap((item) => item.source_refs), review_state: 'unresolved', proposal_id: proposal.id });
      }
    });
    if (!proposal) return response.status(404).json({ error: 'Proposal not found.' });
    response.json({ proposal });
  } catch (error) { next(error); }
});

const kindByRoute: Record<string, ProjectRecord['kind']> = {
  members: 'member', tasks: 'task', deliverables: 'deliverable', risks: 'risk', decisions: 'decision',
};
const recordFieldSchema = z.object({
  title: z.string().trim().min(1).max(240).optional(),
  status: z.string().trim().max(120).nullable().optional(),
  owner: z.string().trim().max(160).nullable().optional(),
  member_type: z.enum(['person', 'organization', 'group', 'role', 'unknown']).optional(),
  documented_skills: z.array(z.string().trim().min(1).max(80)).max(16).optional(),
  availability_note: z.string().trim().max(2000).nullable().optional(),
  collaboration_profile: collaborationProfileSchema.nullable().optional(),
  planned_start: z.string().date().nullable().optional(),
  planned_duration_days: z.number().finite().min(0).max(100000).nullable().optional(),
  effort_hours: z.number().finite().min(0).max(100000).nullable().optional(),
  completed_at: z.union([z.string().date(), z.string().datetime({ offset: true })]).nullable().optional(),
  due: z.string().trim().max(80).nullable().optional(),
  due_basis: z.enum(['reported', 'baseline', 'forecast', 'unknown']).optional(),
  baseline_due: z.string().trim().max(80).nullable().optional(),
  current_forecast: z.string().trim().max(80).nullable().optional(),
  depends_on: z.array(z.string().min(1).max(100)).max(100).optional(),
  description: z.string().trim().max(4_000).nullable().optional(),
  role: z.string().trim().max(160).nullable().optional(),
  reason: z.string().trim().max(1_000).optional(),
}).strict();
const editSchema = recordFieldSchema.extend({
  resolved_dependency_links: z.array(z.object({
    label: z.string().trim().min(1).max(160),
    dependency_id: z.string().uuid(),
  }).strict()).max(100).optional(),
}).refine((value) => Object.keys(value).some((key) => !['reason', 'resolved_dependency_links'].includes(key)), { message: 'At least one record field is required.' });

app.post('/api/projects/:projectId/records/:kind', async (request, response, next) => {
  try {
    const projectId = routeParam(request, 'projectId');
    const kind = kindByRoute[routeParam(request, 'kind')];
    if (!kind) return response.status(400).json({ error: 'Unknown record type.' });
    const parsed = recordFieldSchema.extend({ title: z.string().trim().min(1).max(240) }).safeParse(request.body);
    if (!parsed.success) return response.status(400).json({ error: 'Enter a title and valid project record fields.' });
    const { reason, ...fields } = parsed.data;
    if (kind !== 'member' && fields.collaboration_profile !== undefined) return response.status(400).json({ error: 'Profilul de colaborare aparține unui membru.' });
    let created: ProjectRecord | undefined;
    let graph: ProjectWorkspace['graph'] | undefined;
    await store.transact((state) => {
      const workspace = state.workspaces.find((candidate) => candidate.project.id === projectId);
      if (!workspace) return;
      validateCollaborationReferences(fields.collaboration_profile, workspace.members);
      const duplicate = getRecordArray(workspace, kind).some((record) => normalizedKey(record.title) === normalizedKey(fields.title));
      if (duplicate) return;
      const knownIds = new Set(allRecords(workspace).map((record) => record.id));
      if (fields.depends_on?.some((dependencyId) => !knownIds.has(dependencyId))) return;
      const record = newProjectRecord({
        ...fields,
        kind,
        title: fields.title,
        source_refs: [],
        field_refs: {},
        dependency_refs: Object.fromEntries((fields.depends_on || []).map((dependencyId) => [dependencyId, []])),
        evidence_state: 'expert_observation',
        review_state: 'manager_confirmed',
        reason,
      });
      addStoredRecord(workspace, record);
      created = record;
      appendAudit(workspace, { type: 'record_created', summary: `Manager added ${kind}: ${record.title}`, before: null, after: structuredClone(record), record_id: record.id });
      appendChange(workspace, { type: 'record_created', title: `${kind}: ${record.title}`, summary: reason || 'Manager added a record manually.', source_refs: [], review_state: 'manager_confirmed' });
      refreshGraph(workspace);
      graph = workspace.graph;
    });
    if (!created) return response.status(409).json({ error: 'Project is missing, the record title already exists, or a dependency reference is invalid.' });
    response.status(201).json({ record: created, graph });
  } catch (error) { next(error); }
});

app.patch('/api/projects/:projectId/records/:kind/:recordId', async (request, response, next) => {
  try {
    const kind = kindByRoute[routeParam(request, 'kind')];
    if (!kind) return response.status(400).json({ error: 'Unknown record type.' });
    const parsed = editSchema.safeParse(request.body);
    if (!parsed.success) return response.status(400).json({ error: 'The record update contains invalid fields.' });
    const { reason, resolved_dependency_links: resolvedDependencyLinks = [], ...fields } = parsed.data;
    if (kind !== 'member' && fields.collaboration_profile !== undefined) return response.status(400).json({ error: 'Profilul de colaborare aparține unui membru.' });
    let updated: ProjectRecord | undefined;
    let graph: ProjectWorkspace['graph'] | undefined;
    await store.transact((state) => {
      const workspace = state.workspaces.find((candidate) => candidate.project.id === routeParam(request, 'projectId'));
      if (!workspace) return;
      const record = currentRecord(workspace, kind, routeParam(request, 'recordId'));
      if (!record) return;
      validateCollaborationReferences(fields.collaboration_profile, workspace.members, record.id);
      const before = structuredClone(record);
      const selectedDependencyIds = fields.depends_on || record.depends_on;
      if (fields.depends_on) {
        const knownIds = new Set(allRecords(workspace).map((item) => item.id));
        if (fields.depends_on.some((dependencyId) => !knownIds.has(dependencyId))) return;
        if (fields.depends_on.includes(record.id)) return;
        if (kind === 'task' || kind === 'deliverable') {
          assertTaskDependencyAcyclic([...workspace.tasks, ...workspace.deliverables], { [record.id]: fields.depends_on });
        }
      }
      if (resolvedDependencyLinks.length) {
        const selectedIds = new Set(selectedDependencyIds);
        const unresolved = new Set(record.unresolved_dependencies || []);
        if (resolvedDependencyLinks.some((link) => !selectedIds.has(link.dependency_id) || !unresolved.has(link.label))) return;
        if (new Set(resolvedDependencyLinks.map((link) => link.label)).size !== resolvedDependencyLinks.length) return;
      }
      if (fields.depends_on || resolvedDependencyLinks.length) {
        const selected = fields.depends_on || record.depends_on;
        const selection = manualDependencySelection(record, selected, resolvedDependencyLinks);
        record.dependency_refs = selection.dependency_refs;
        record.unresolved_dependencies = selection.unresolved_dependencies;
      }
      Object.assign(record, fields, { updated_at: now(), review_state: 'manager_corrected', evidence_state: 'expert_observation', reason: reason || record.reason });
      record.field_refs = { ...(record.field_refs || {}) };
      for (const field of Object.keys(fields)) {
        if (field !== 'title' && field !== 'description' && field !== 'role') record.field_refs[field] = [];
      }
      updated = record;
      appendAudit(workspace, { type: 'record_edited', summary: `Manager edited ${kind}: ${record.title}`, before, after: structuredClone(record), record_id: record.id });
      appendChange(workspace, { type: 'record_edited', title: `${kind}: ${record.title}`, summary: reason || 'Manager corrected a project record.', source_refs: [], review_state: 'manager_corrected' });
      refreshGraph(workspace);
      graph = workspace.graph;
    });
    if (!updated) return response.status(404).json({ error: 'Project or record not found, or the dependency reference is invalid.' });
    response.json({ record: updated, graph });
  } catch (error) {
    if (error instanceof DependencyCycleError) return response.status(409).json({ error: error.message, cycle: error.cycle });
    next(error);
  }
});

app.get('/api/projects/:projectId/impact', async (request, response, next) => {
  try {
    const workspace = await projectOr404(routeParam(request, 'projectId'));
    if (!workspace) return response.status(404).json({ error: 'Project not found.' });
    const taskId = String(request.query.taskId || '');
    if (!taskId) return response.status(400).json({ error: 'Choose a task to calculate downstream impact.' });
    const task = currentRecord(workspace, 'task', taskId) || currentRecord(workspace, 'deliverable', taskId);
    if (!task) return response.status(404).json({ error: 'Task or deliverable not found.' });
    response.json(calculateImpact(workspace, taskId));
  } catch (error) { next(error); }
});

const builtFrontend = path.resolve(process.cwd(), 'dist');
if (existsSync(path.join(builtFrontend, 'index.html'))) {
  app.use(express.static(builtFrontend, { index: false, fallthrough: true }));
  app.get('*', (request, response, next) => {
    if (request.path.startsWith('/api/')) return next();
    response.sendFile(path.join(builtFrontend, 'index.html'));
  });
}

app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
  if (error instanceof CollaborationReferenceError) return response.status(400).json({ error: error.message });
  if (error instanceof multer.MulterError) {
    const status = error.code === 'LIMIT_FILE_SIZE' || error.code === 'LIMIT_FILE_COUNT' ? 413 : 400;
    return response.status(status).json({ error: error.code === 'LIMIT_FILE_SIZE' ? 'A file exceeds the 16 MB per-file limit.' : error.code === 'LIMIT_FILE_COUNT' ? `Choose no more than ${UPLOAD_LIMIT} files at a time.` : 'The uploaded files could not be read.' });
  }
  const message = error instanceof Error ? error.message : 'The local project service failed.';
  return response.status(500).json({ error: message.slice(0, 500) });
});

async function start() {
  await store.initialize();
  for (const job of await store.listJobs()) jobs.set(job.id, job);
  if (process.env.TC_API_NO_LISTEN === '1') return;
  await inspectCodexCli();
  const server = app.listen(API_PORT, '127.0.0.1', () => {
    process.stdout.write(`TeamCreator GigaHack API listening at http://127.0.0.1:${API_PORT}\n`);
  });
  server.on('error', (error: NodeJS.ErrnoException) => {
    process.stderr.write(error.code === 'EADDRINUSE'
      ? `Port ${API_PORT} is already in use. Stop the existing service or set TC_GIGAHACK_API_PORT to another free port.\n`
      : `Local API could not start: ${error.message}\n`);
    process.exitCode = 1;
  });
}

void start();

export { app, store };
