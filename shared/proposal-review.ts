import { z } from 'zod';
import type { ProjectWorkspace, ProjectRecord } from './types';
import { assertTaskDependencyAcyclic } from './dependency-validation';

const nullable = (max: number) => z.string().trim().max(max).nullable().optional();
export const itemReviewSchema = z.object({
  action: z.enum(['reject', 'correct']), reason: z.string().trim().min(1).max(1000),
  fields: z.object({ title: z.string().trim().min(1).max(240).optional(), owner: nullable(160), status: nullable(120), due: nullable(80),
    completed_at: nullable(80), baseline_due: nullable(80), current_forecast: nullable(80), description: nullable(4000), role: nullable(160),
    due_basis: z.enum(['reported', 'baseline', 'forecast', 'unknown']).optional(),
    member_type: z.enum(['person', 'organization', 'group', 'role', 'unknown']).optional(),
    depends_on: z.array(z.string().min(1).max(100)).max(100).optional(),
  }).strict().optional(),
}).strict().refine(value => value.action === 'reject' || (value.fields && Object.keys(value.fields).length > 0));

/** Edits proposal state only. A correction remains pending until a separate accept action. */
export function reviewProposalItem(workspace: ProjectWorkspace, proposalId: string, itemId: string, body: unknown) {
  const request = itemReviewSchema.parse(body);
  const proposal = workspace.proposals.find(value => value.id === proposalId);
  const item = proposal?.items.find(value => value.id === itemId);
  if (!proposal || proposal.status !== 'proposed' || !item || item.review_state === 'manager_confirmed') throw new Error('Propunerea nu mai este în așteptare.');
  const timestamp = new Date().toISOString();
  const before = structuredClone(item);
  if (request.action === 'reject') {
    const rejected = { ...structuredClone(proposal), id: crypto.randomUUID(), items: [structuredClone(item)], status: 'rejected' as const,
      decided_at: timestamp, decision_reason: request.reason, summary: request.reason,
      conflicts: proposal.conflicts.filter(value => value.record_title === item.title) };
    proposal.items = proposal.items.filter(value => value.id !== itemId);
    proposal.conflicts = proposal.conflicts.filter(value => value.record_title !== item.title);
    workspace.proposals.unshift(rejected);
    if (!proposal.items.some(value => value.review_state !== 'manager_confirmed')) {
      proposal.status = proposal.items.length ? 'applied' : 'rejected'; proposal.decided_at = timestamp;
    }
  } else {
    const fields = request.fields!;
    const records = [...workspace.members, ...workspace.tasks, ...workspace.deliverables, ...workspace.risks, ...workspace.decisions];
    if (fields.depends_on?.some(id => id === item.record_id || !records.some(record => record.id === id))) throw new Error('Dependență invalidă.');
    if (fields.depends_on && item.record_id && (item.record_kind === 'task' || item.record_kind === 'deliverable')) {
      const overrides: Record<string, readonly string[]> = {};
      for (const sibling of proposal.items) {
        if (sibling.id === item.id || sibling.operation !== 'update' || !sibling.record_id || !sibling.fields.depends_on) continue;
        if (sibling.record_kind === 'task' || sibling.record_kind === 'deliverable') overrides[sibling.record_id] = sibling.fields.depends_on;
      }
      overrides[item.record_id] = fields.depends_on;
      assertTaskDependencyAcyclic([...workspace.tasks, ...workspace.deliverables], overrides);
    }
    const current = records.find(record => record.id === item.record_id);
    if (item.operation === 'update' && !current) throw new Error('Înregistrarea de corectat lipsește.');
    item.fields = { ...item.fields, ...fields, evidence_state: 'expert_observation', reason: request.reason, field_refs: { ...item.fields.field_refs } };
    for (const key of Object.keys(fields)) item.fields.field_refs![key] = [];
    if (fields.owner !== undefined) item.fields.owner_id = null;
    if (fields.depends_on) item.fields.dependency_refs = Object.fromEntries(fields.depends_on.map(id => [id, []]));
    if (current) item.before = Object.fromEntries(Object.keys(item.fields).map(key => [key, (current as any)[key]])) as Partial<ProjectRecord>;
    proposal.conflicts = proposal.conflicts.filter(value => value.record_title !== item.title);
    if (fields.title) item.title = fields.title;
    item.conflict = false; item.stale = false; item.review_state = 'unreviewed';
  }
  const type = request.action === 'reject' ? 'proposal_rejected' as const : 'record_edited' as const;
  workspace.audit.unshift({ id: crypto.randomUUID(), project_id: workspace.project.id, at: timestamp, actor: 'manager', type,
    summary: `${request.action === 'reject' ? 'Respins' : 'Corectat pentru revizuire'}: ${before.title}. ${request.reason}`, before, after: request.action === 'correct' ? structuredClone(item) : null,
    proposal_id: proposal.id, source_ids: item.source_refs.map(ref => ref.source_id) });
  workspace.changes.unshift({ id: crypto.randomUUID(), project_id: workspace.project.id, at: timestamp, type, title: before.title,
    summary: request.reason, source_refs: item.source_refs, review_state: request.action === 'correct' ? 'manager_corrected' : 'unresolved', proposal_id: proposal.id });
  workspace.project.updated_at = timestamp;
  return { proposal };
}
