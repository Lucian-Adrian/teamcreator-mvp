import { z } from 'zod';
import type { ProjectWorkspace, ProjectProposal, ProjectRecord } from './types';
import { itemReviewSchema } from './proposal-review';
import { assertTaskDependencyAcyclic, normalizeSourceRefLocation } from './dependency-validation';

export async function projectVersion(workspace: ProjectWorkspace) {
  const data = JSON.stringify(workspace);
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(data));
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function getProjectContext(workspace: ProjectWorkspace) {
  return { version: await projectVersion(workspace), project: workspace.project,
    accepted: { members: workspace.members, tasks: workspace.tasks, deliverables: workspace.deliverables, risks: workspace.risks, decisions: workspace.decisions },
    pending: workspace.proposals.filter(value => value.status === 'proposed'), dependencies: workspace.dependencies, graph: workspace.graph,
    sources: workspace.sources.map(({ excerpt, ...source }) => source), recent_changes: workspace.changes.slice(0, 30),
    capabilities: { read_project: true, get_evidence: true, propose_changes: true, run_simulation: true, apply_approved_changes: 'PM review in TeamCreator', codex_plugin: false, claude_plugin: false },
  };
}

const itemSchema = z.object({ record_kind: z.enum(['member', 'task', 'deliverable', 'risk', 'decision']), record_id: z.string().nullable(), title: z.string().min(1).max(240),
  fields: itemReviewSchema.innerType().shape.fields.unwrap(),
  source_refs: z.array(z.object({ source_id: z.string(), location: z.string().min(1).max(500), quote: z.string().min(1).max(2048) }).strict()).min(1).max(12),
}).strict();
export const agentProposalSchema = z.object({ based_on_version: z.string().regex(/^[a-f0-9]{64}$/), title: z.string().min(1).max(240), summary: z.string().max(2000), items: z.array(itemSchema).min(1).max(80) }).strict();

export async function proposeProjectChanges(workspace: ProjectWorkspace, body: unknown, key: string, textBySource: Record<string, string>) {
  const request = agentProposalSchema.parse(body);
  if (!/^[\w.-]{8,160}$/.test(key)) throw new Error('Idempotency-Key required (8–160 characters).');
  const fingerprintBytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(request)));
  const fingerprint = Array.from(new Uint8Array(fingerprintBytes), byte => byte.toString(16).padStart(2, '0')).join('');
  const existing = workspace.proposals.find(value => value.agent_request?.key === key);
  if (existing) {
    if (existing.agent_request?.fingerprint !== fingerprint) throw new Error('Idempotency key already used with different data.');
    return { proposal: existing, replayed: true };
  }
  if (request.based_on_version !== await projectVersion(workspace)) throw new Error('Project version changed. Read context again before proposing.');
  const records = [...workspace.members, ...workspace.tasks, ...workspace.deliverables, ...workspace.risks, ...workspace.decisions];
  const normalizedRefs = new Map<typeof request.items[number], typeof request.items[number]['source_refs']>();
  const dependencyOverrides: Record<string, readonly string[]> = {};
  for (const item of request.items) {
    if (item.record_id && !records.some(record => record.id === item.record_id && record.kind === item.record_kind)) throw new Error('Unknown record target.');
    if (item.fields.depends_on?.some(id => id === item.record_id || !records.some(record => record.id === id))) throw new Error('Unknown dependency.');
    const refs = item.source_refs.map(ref => {
      if (!workspace.sources.some(source => source.id === ref.source_id)) throw new Error('Evidence must exactly match a source in this project.');
      const normalized = normalizeSourceRefLocation(textBySource[ref.source_id] || '', ref);
      if (!normalized) throw new Error('Evidence must exactly match a source in this project.');
      return normalized;
    });
    normalizedRefs.set(item, refs);
    if (item.record_id && item.fields.depends_on && (item.record_kind === 'task' || item.record_kind === 'deliverable')) dependencyOverrides[item.record_id] = item.fields.depends_on;
  }
  assertTaskDependencyAcyclic([...workspace.tasks, ...workspace.deliverables], dependencyOverrides);
  const timestamp = new Date().toISOString();
  const proposal: ProjectProposal = { id: crypto.randomUUID(), project_id: workspace.project.id, title: request.title, summary: request.summary, status: 'proposed',
    source_ids: [...new Set(request.items.flatMap(item => normalizedRefs.get(item)!.map(ref => ref.source_id)))],
    items: request.items.map(item => {
      const current = records.find(record => record.id === item.record_id);
      const itemRefs = normalizedRefs.get(item)!;
      const fields: Partial<ProjectRecord> = { ...item.fields, field_refs: Object.fromEntries(Object.keys(item.fields).map(key => [key, []])), evidence_state: 'supported' };
      return { id: crypto.randomUUID(), operation: current ? 'update' : 'create', record_kind: item.record_kind, record_id: item.record_id, title: item.title, fields,
        before: current ? { ...Object.fromEntries(Object.keys(fields).map(key => [key, (current as any)[key]])), title: current.title } : null,
        source_refs: itemRefs, consequential: true, review_state: 'unreviewed' };
    }), conflicts: [], missing_info: [], provider_mode: 'degraded', provider_model: null, created_at: timestamp,
    agent_request: { key, fingerprint, based_on_version: request.based_on_version },
  };
  workspace.proposals.unshift(proposal);
  workspace.audit.unshift({ id: crypto.randomUUID(), project_id: workspace.project.id, at: timestamp, actor: 'external agent proposal', type: 'proposal_created', summary: proposal.title,
    proposal_id: proposal.id, source_ids: proposal.source_ids });
  workspace.project.updated_at = timestamp;
  return { proposal, replayed: false };
}
