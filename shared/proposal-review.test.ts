import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSyntheticDemoWorkspace } from '../server/demo-fixture';
import { reviewProposalItem } from './proposal-review';
import type { ProjectProposal } from './types';

function fixture() {
  const workspace = buildSyntheticDemoWorkspace('test', '2026-09-27T00:00:00.000Z');
  const task = workspace.tasks[0];
  const proposal: ProjectProposal = { id: 'proposal', project_id: 'test', title: 'Changes', summary: '', status: 'proposed', source_ids: [],
    items: [1, 2].map(n => ({ id: `item-${n}`, operation: 'update', record_kind: 'task', record_id: task.id, title: task.title, fields: { owner: `Owner ${n}` }, before: { owner: task.owner }, source_refs: task.source_refs, consequential: true, review_state: 'unreviewed' })),
    conflicts: [], missing_info: [], provider_mode: 'degraded', provider_model: null, created_at: '2026-09-27T00:00:00.000Z' };
  workspace.proposals = [proposal]; return workspace;
}
test('per-item rejection preserves siblings, accepted state and evidence', () => {
  const workspace = fixture(); const tasks = structuredClone(workspace.tasks);
  reviewProposalItem(workspace, 'proposal', 'item-1', { action: 'reject', reason: 'Unsupported owner.' });
  assert.deepEqual(workspace.tasks, tasks);
  assert.equal(workspace.proposals.find(p => p.id === 'proposal')!.items.length, 1);
  assert.equal(workspace.proposals[0].status, 'rejected');
  assert.equal(workspace.proposals[0].items[0].source_refs.length > 0, true);
  assert.equal(workspace.audit[0].type, 'proposal_rejected');
});
test('correction remains pending, records current baseline and clears false field attribution', () => {
  const workspace = fixture(); const tasks = structuredClone(workspace.tasks);
  reviewProposalItem(workspace, 'proposal', 'item-1', { action: 'correct', reason: 'Checked with PM.', fields: { owner: 'Confirmed owner', title: 'Corrected title' } });
  const item = workspace.proposals[0].items[0];
  assert.deepEqual(workspace.tasks, tasks); assert.equal(item.review_state, 'unreviewed');
  assert.equal(item.fields.evidence_state, 'expert_observation'); assert.deepEqual(item.fields.field_refs?.owner, []);
  assert.equal(item.before?.title, tasks[0].title); assert.equal(item.title, 'Corrected title');
  assert.throws(() => reviewProposalItem(workspace, 'proposal', 'item-2', { action: 'correct', reason: 'Bad link', fields: { depends_on: ['unknown'] } }));
});

test('correcting a task dependency rejects a proposal cycle before changing audit or review state', () => {
  const workspace = buildSyntheticDemoWorkspace('cycle-review-test', '2026-09-27T00:00:00.000Z');
  const [first, second] = workspace.tasks;
  const proposal: ProjectProposal = {
    id: 'cycle-proposal', project_id: workspace.project.id, title: 'Cycle', summary: '', status: 'proposed', source_ids: [],
    items: [
      { id: 'cycle-a', operation: 'update', record_kind: 'task', record_id: first.id, title: first.title, fields: { depends_on: [second.id] }, before: { depends_on: first.depends_on }, source_refs: first.source_refs, consequential: true, review_state: 'unreviewed' },
      { id: 'cycle-b', operation: 'update', record_kind: 'task', record_id: second.id, title: second.title, fields: { depends_on: [first.id] }, before: { depends_on: second.depends_on }, source_refs: second.source_refs, consequential: true, review_state: 'unreviewed' },
    ],
    conflicts: [], missing_info: [], provider_mode: 'degraded', provider_model: null, created_at: '2026-09-27T00:00:00.000Z',
  };
  workspace.proposals.unshift(proposal);
  const proposalBefore = structuredClone(proposal);
  const auditLength = workspace.audit.length;
  assert.throws(() => reviewProposalItem(workspace, proposal.id, 'cycle-a', { action: 'correct', reason: 'Keep proposal pending.', fields: { depends_on: [second.id] } }), /ciclu/i);
  assert.deepEqual(workspace.proposals[0], proposalBefore);
  assert.equal(workspace.audit.length, auditLength);
});
