import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSyntheticDemoWorkspace } from '../server/demo-fixture';
import { getProjectContext, proposeProjectChanges } from './agent-context';

test('agent loop enforces source, version, idempotency and leaves PM state untouched', async () => {
  const workspace = buildSyntheticDemoWorkspace('agent-qa', '2026-09-27T00:00:00.000Z');
  const task = workspace.tasks[0];
  const source = workspace.sources.find(source => source.id === task.source_refs[0].source_id)!;
  const sourceTexts = Object.fromEntries(workspace.sources.map(source => [source.id, source.excerpt || '']));
  const context = await getProjectContext(workspace);
  assert.equal(context.sources.some(source => 'excerpt' in source), false);
  const suppliedRef = { ...task.source_refs[0], location: 'line 999' };
  const body = { based_on_version: context.version, title: 'Agent suggests review', summary: 'Synthetic agent loop', items: [{ record_kind: 'task', record_id: task.id, title: task.title, fields: { description: 'Review this sourced commitment.' }, source_refs: [suppliedRef] }] };
  const tasks = structuredClone(workspace.tasks);
  const result = await proposeProjectChanges(workspace, body, 'agent-request-001', sourceTexts);
  assert.equal(result.proposal.status, 'proposed'); assert.deepEqual(workspace.tasks, tasks);
  assert.notEqual(result.proposal.items[0].source_refs[0].location, 'line 999');
  assert.deepEqual(result.proposal.items[0].fields.field_refs?.description, []);
  assert.equal((await proposeProjectChanges(workspace, body, 'agent-request-001', sourceTexts)).replayed, true);
  assert.equal(workspace.proposals.filter(p => p.agent_request).length, 1);
  await assert.rejects(proposeProjectChanges(workspace, { ...body, summary: 'Different' }, 'agent-request-001', sourceTexts), /different data/);
  await assert.rejects(proposeProjectChanges(workspace, body, 'agent-request-002', sourceTexts), /version changed/);
  const newer = await getProjectContext(workspace);
  await assert.rejects(proposeProjectChanges(workspace, { ...body, based_on_version: newer.version, items: [{ ...body.items[0], source_refs: [{ source_id: source.id, location: 'line 1', quote: 'invented evidence' }] }] }, 'agent-request-003', sourceTexts), /exactly match/);
});

test('agent proposal rejects cycles across multiple task updates before saving', async () => {
  const workspace = buildSyntheticDemoWorkspace('agent-cycle-qa', '2026-09-27T00:00:00.000Z');
  const [first, second] = workspace.tasks;
  const sourceTexts = Object.fromEntries(workspace.sources.map(source => [source.id, source.excerpt || '']));
  const context = await getProjectContext(workspace);
  const originalProposalCount = workspace.proposals.length;
  const body = {
    based_on_version: context.version,
    title: 'Cyclic task update',
    summary: 'Synthetic negative case',
    items: [
      { record_kind: 'task', record_id: first.id, title: first.title, fields: { depends_on: [second.id] }, source_refs: [first.source_refs[0]] },
      { record_kind: 'task', record_id: second.id, title: second.title, fields: { depends_on: [first.id] }, source_refs: [second.source_refs[0]] },
    ],
  };
  await assert.rejects(proposeProjectChanges(workspace, body, 'agent-cycle-request-1', sourceTexts), /ciclu/i);
  assert.equal(workspace.proposals.length, originalProposalCount);
});
