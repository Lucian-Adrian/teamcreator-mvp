import type { ProjectRecord, ProjectWorkspace, SourceRef } from '../shared/types.js';
import { calculateImpact } from './impact.js';

export type ProjectExportFormat = 'json' | 'markdown';

export interface ProjectExportFile {
  fileName: string;
  contentType: string;
  content: string;
}

interface ProjectSnapshot {
  schema_version: 1;
  generated_at: string;
  snapshot_type: 'project_state_only';
  source_files_included: false;
  project: ProjectWorkspace['project'];
  accepted_state: Pick<ProjectWorkspace,
    'members' | 'tasks' | 'deliverables' | 'risks' | 'decisions' | 'dependencies' | 'assignments' | 'graph'>;
  sources: ProjectWorkspace['sources'];
  changes: ProjectWorkspace['changes'];
  audit: ProjectWorkspace['audit'];
  pending_proposals: Array<{
    id: string;
    title: string;
    summary: string;
    status: 'proposed_not_applied';
    created_at: string;
    source_ids: string[];
    items: Array<{
      id: string;
      operation: string;
      record_kind: string;
      record_id: string | null;
      title: string;
      fields: object;
      source_refs: SourceRef[];
      review_state: string;
      conflict: boolean;
      stale: boolean;
    }>;
  }>;
}

function safeName(value: string) {
  const slug = value.normalize('NFKD').replace(/\p{M}/gu, '')
    .replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64).toLowerCase();
  return slug || 'teamcreator-project';
}

function timeSlug(value: string) {
  return value.replace(/[^0-9TZ]/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '') || 'snapshot';
}

function snapshotFor(workspace: ProjectWorkspace, generatedAt: string): ProjectSnapshot {
  return {
    schema_version: 1,
    generated_at: generatedAt,
    snapshot_type: 'project_state_only',
    source_files_included: false,
    project: workspace.project,
    accepted_state: {
      members: workspace.members,
      tasks: workspace.tasks,
      deliverables: workspace.deliverables,
      risks: workspace.risks,
      decisions: workspace.decisions,
      dependencies: workspace.dependencies,
      assignments: workspace.assignments,
      graph: workspace.graph,
    },
    sources: workspace.sources.map((source) => ({
      id: source.id,
      name: source.name,
      relative_path: source.relative_path,
      sha256: source.sha256,
      size: source.size,
      media_type: source.media_type,
      parser_status: source.parser_status,
      created_at: source.created_at,
      error: source.error,
    })),
    changes: workspace.changes,
    audit: workspace.audit,
    pending_proposals: workspace.proposals.filter((proposal) => proposal.status === 'proposed').map((proposal) => ({
      id: proposal.id,
      title: proposal.title,
      summary: proposal.summary,
      status: 'proposed_not_applied',
      created_at: proposal.created_at,
      source_ids: proposal.source_ids,
      items: proposal.items.filter((item) => item.review_state !== 'manager_confirmed' && item.review_state !== 'manager_corrected').map((item) => ({
        id: item.id,
        operation: item.operation,
        record_kind: item.record_kind,
        record_id: item.record_id,
        title: item.title,
        fields: item.fields,
        source_refs: item.source_refs,
        review_state: item.review_state,
        conflict: Boolean(item.conflict),
        stale: Boolean(item.stale),
      })),
    })),
  };
}

function oneLine(value: string) {
  return value.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function sourceLine(ref: SourceRef, sourceById: Map<string, ProjectWorkspace['sources'][number]>) {
  const source = sourceById.get(ref.source_id);
  const name = source?.relative_path || source?.name || ref.source_id;
  const quote = oneLine(ref.quote);
  return `- ${name} (${oneLine(ref.location)}): "${quote}"`;
}

function recordRefs(record: ProjectRecord) {
  const fieldRefs = record.field_refs ? Object.values(record.field_refs).flat() : [];
  const candidates = [...record.source_refs, ...fieldRefs];
  const unique = new Map<string, SourceRef>();
  for (const ref of candidates) unique.set(`${ref.source_id}\u0000${ref.location}\u0000${ref.quote}`, ref);
  return [...unique.values()];
}

function refsForFields(record: ProjectRecord, fields: string[]) {
  const fieldRefs = fields.flatMap((field) => record.field_refs?.[field] || []);
  if (!fieldRefs.length) return recordRefs(record);
  const unique = new Map<string, SourceRef>();
  for (const ref of fieldRefs) unique.set(`${ref.source_id}\u0000${ref.location}\u0000${ref.quote}`, ref);
  return [...unique.values()];
}

function statusLabel(record: ProjectRecord) {
  return record.status?.trim() || 'not recorded';
}

function ownerLabel(record: ProjectRecord) {
  return record.owner?.trim() || 'not recorded';
}

function formatRecordFacts(record: ProjectRecord, sourceById: Map<string, ProjectWorkspace['sources'][number]>) {
  const facts = [`**${record.title}** (${record.kind})`];
  if (record.kind === 'member') {
    facts.push(`Type: ${record.member_type || 'unknown'}`);
    if (record.role) facts.push(`Role: ${oneLine(record.role)}`);
  } else {
    facts.push(`Status: ${statusLabel(record)}`);
    facts.push(`Owner: ${ownerLabel(record)}`);
    if (record.due) facts.push(`${record.due_basis === 'baseline' ? 'Baseline date' : 'Current due'}: ${record.due}`);
    if (record.baseline_due) facts.push(`Baseline date: ${record.baseline_due}`);
    if (record.current_forecast) facts.push(`Current forecast: ${record.current_forecast}`);
    if (record.completed_at) facts.push(`Completed at: ${record.completed_at}`);
    if (record.depends_on.length) facts.push(`Depends on: ${record.depends_on.join(', ')}`);
    if (record.unresolved_dependencies?.length) facts.push(`Unresolved dependency names: ${record.unresolved_dependencies.join(', ')}`);
  }
  const refs = recordRefs(record);
  if (refs.length) facts.push(`Evidence:\n${refs.map((ref) => sourceLine(ref, sourceById)).join('\n')}`);
  else facts.push('Evidence: no source reference saved.');
  return `- ${facts.join('\n  ')}`;
}

function activeRecord(record: ProjectRecord) {
  return !/^(complete|completed|done|finished)$/i.test(record.status || '');
}

function buildMarkdown(workspace: ProjectWorkspace, generatedAt: string) {
  const sourceById = new Map(workspace.sources.map((source) => [source.id, source]));
  const records = [...workspace.members, ...workspace.tasks, ...workspace.deliverables, ...workspace.risks, ...workspace.decisions];
  const markdown: string[] = [
    `# Daily brief: ${oneLine(workspace.project.name)}`,
    '',
    `Generated at: ${generatedAt} (UTC)`,
    '',
    'This brief summarizes accepted project state. Proposed changes are not treated as facts. Original source files are not included in this export; they remain in the local data folder.',
    '',
    '## Current facts',
    '',
  ];

  if (records.length) markdown.push(...records.map((record) => formatRecordFacts(record, sourceById)));
  else markdown.push('No accepted people, work, or deliverables are recorded yet.');

  const questions: string[] = [];
  for (const record of [...workspace.tasks, ...workspace.deliverables]) {
    if (!activeRecord(record)) continue;
    if (!record.owner) questions.push(`Confirm the owner for ${record.title}.`);
    if (record.evidence_state === 'conflict') questions.push(`Resolve the conflicting source claims for ${record.title}.`);
    if (record.unresolved_dependencies?.length) questions.push(`Resolve the dependency reference for ${record.title}: ${record.unresolved_dependencies.join(', ')}.`);
    if (!record.due && !record.baseline_due && !record.current_forecast) questions.push(`Confirm whether ${record.title} has a current due date.`);
  }
  if (workspace.graph.has_cycles) {
    for (const cycle of workspace.graph.cycles) {
      const titles = cycle.map((recordId) => records.find((record) => record.id === recordId)?.title || recordId);
      questions.push(`Correct the dependency cycle involving ${titles.join(' -> ')}.`);
    }
  }
  const failedSources = workspace.sources.filter((source) => source.parser_status === 'unsupported' || source.parser_status === 'failed' || source.parser_status === 'empty');
  for (const source of failedSources) questions.push(`Review source ${source.relative_path || source.name}: ${source.error || source.parser_status}.`);
  const uniqueQuestions = [...new Set(questions)];

  markdown.push('', '## Open questions', '');
  if (uniqueQuestions.length) markdown.push(...uniqueQuestions.map((question) => `- ${question}`));
  else markdown.push('No unresolved owner, dependency, date, or source questions are recorded.');

  const actions = new Map<string, SourceRef[]>();
  const addAction = (action: string, refs: SourceRef[] = []) => {
    const combined = [...(actions.get(action) || []), ...refs];
    const unique = new Map<string, SourceRef>();
    for (const ref of combined) unique.set(`${ref.source_id}\u0000${ref.location}\u0000${ref.quote}`, ref);
    actions.set(action, [...unique.values()]);
  };
  for (const task of workspace.tasks) {
    if (!activeRecord(task)) continue;
    if (task.status?.toLowerCase() === 'blocked') {
      addAction(`Resolve the recorded blocker for ${task.title}.`, refsForFields(task, ['status']));
      const impact = calculateImpact(workspace, task.id);
      for (const path of impact.paths) {
        const nodeTitles = [path.from_title, ...path.via.map((node) => node.title), path.affected_title];
        addAction(`Calculated dependency path: ${nodeTitles.join(' -> ')}.`, path.source_refs);
      }
    } else if (task.due) {
      addAction(`Review progress on ${task.title} by ${task.due}.`, refsForFields(task, ['status', 'due']));
    } else {
      addAction(`Confirm the next step for ${task.title}.`, refsForFields(task, ['status']));
    }
    if (!task.owner) addAction(`Confirm an owner for ${task.title}.`, refsForFields(task, ['owner']));
  }
  for (const deliverable of workspace.deliverables) {
    if (!activeRecord(deliverable)) continue;
    if (!deliverable.owner) addAction(`Confirm an owner for ${deliverable.title}.`, refsForFields(deliverable, ['owner']));
    if (deliverable.status?.toLowerCase() === 'blocked') addAction(`Resolve the recorded blocker for ${deliverable.title}.`, refsForFields(deliverable, ['status']));
  }

  markdown.push('', '## Suggested next actions', '', 'These actions follow from accepted records; dependency paths are calculated, not probabilities.');
  markdown.push('');
  if (actions.size) {
    for (const [action, refs] of actions) {
      markdown.push(`- ${action}`);
      if (refs.length) markdown.push(...refs.map((ref) => `  - Evidence: ${sourceLine(ref, sourceById).replace(/^- /, '')}`));
    }
  }
  else markdown.push('No next action is inferred from the accepted project state.');

  markdown.push('', '## Source inventory', '');
  if (workspace.sources.length) {
    markdown.push(...workspace.sources.map((source) => `- ${source.relative_path || source.name}: ${source.parser_status}, SHA-256 ${source.sha256}${source.error ? `, ${oneLine(source.error)}` : ''}`));
  } else markdown.push('No sources are recorded.');
  markdown.push('');
  return markdown.join('\n');
}

export function buildProjectExport(
  workspace: ProjectWorkspace,
  format: ProjectExportFormat,
  generatedAt = new Date().toISOString(),
): ProjectExportFile {
  const baseName = `${safeName(workspace.project.name)}-${timeSlug(generatedAt)}`;
  if (format === 'json') {
    return {
      fileName: `${baseName}-snapshot.json`,
      contentType: 'application/json; charset=utf-8',
      content: JSON.stringify(snapshotFor(workspace, generatedAt), null, 2),
    };
  }
  return {
    fileName: `${baseName}-daily-brief.md`,
    contentType: 'text/markdown; charset=utf-8',
    content: buildMarkdown(workspace, generatedAt),
  };
}
