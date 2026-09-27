import assert from 'node:assert/strict';
import test from 'node:test';
import type { ProjectWorkspace } from '../shared/types.js';
import { buildProjectExport } from './exports.js';

const timestamp = '2026-09-26T12:00:00.000Z';

function sampleWorkspace(): ProjectWorkspace {
  const sourceRef = { source_id: 'src-1', location: 'row 2', quote: 'T-501 remains blocked until the map index is checked.' };
  const task = {
    id: 'task-1', kind: 'task' as const, title: 'Check the map index', status: 'blocked', owner: null, owner_id: null,
    due: '2026-10-03', due_basis: 'reported' as const, completed_at: null, depends_on: [], source_refs: [sourceRef],
    evidence_state: 'supported' as const, review_state: 'manager_confirmed' as const, created_at: timestamp, updated_at: timestamp,
    field_refs: { status: [sourceRef], due: [sourceRef] },
  };
  const deliverable = {
    id: 'delivery-1', kind: 'deliverable' as const, title: 'Searchable atlas handover', status: null, owner: null,
    due: null, baseline_due: '2026-10-20', current_forecast: null, depends_on: ['task-1'], source_refs: [sourceRef],
    dependency_refs: { 'task-1': [sourceRef] },
    evidence_state: 'supported' as const, review_state: 'manager_confirmed' as const, created_at: timestamp, updated_at: timestamp,
    unresolved_dependencies: ['External clearance'],
  };
  return {
    project: { id: 'project-1', name: 'Coastal Atlas / Review', created_at: timestamp, updated_at: timestamp, synthetic: false },
    members: [], tasks: [task], deliverables: [deliverable], risks: [], decisions: [],
    dependencies: [{ id: 'delivery-1:task-1', from_id: 'delivery-1', to_id: 'task-1', evidence_state: 'supported', source_refs: [sourceRef] }],
    assignments: [],
    sources: [{ id: 'src-1', name: 'task-register.csv', relative_path: 'inputs/task-register.csv', sha256: 'a'.repeat(64), size: 140, media_type: 'text/csv', parser_status: 'parsed', created_at: timestamp }],
    proposals: [{
      id: 'proposal-1', project_id: 'project-1', title: 'Pending status change', summary: 'A proposed completion claim.', status: 'proposed',
      source_ids: ['src-1'], created_at: timestamp, items: [{
        id: 'item-1', operation: 'update', record_kind: 'task', record_id: 'task-1', title: 'Check the map index',
        fields: { status: 'complete' }, before: { status: 'blocked' }, source_refs: [sourceRef], consequential: true,
        review_state: 'unreviewed', conflict: false, stale: false,
      }], conflicts: [], missing_info: [], provider_mode: 'model', provider_model: 'gpt-6-luna',
    }],
    changes: [], audit: [], graph: { cycles: [], has_cycles: false },
  };
}

test('JSON export distinguishes accepted state from pending proposal items and excludes source file bytes', () => {
  const workspace = sampleWorkspace();
  const before = structuredClone(workspace);
  const file = buildProjectExport(workspace, 'json', timestamp);
  const snapshot = JSON.parse(file.content);

  assert.equal(file.contentType, 'application/json; charset=utf-8');
  assert.match(file.fileName, /^coastal-atlas-review-2026-09-26T12-00-00-000Z-snapshot\.json$/);
  assert.equal(snapshot.generated_at, timestamp);
  assert.equal(snapshot.snapshot_type, 'project_state_only');
  assert.equal(snapshot.source_files_included, false);
  assert.equal(snapshot.accepted_state.tasks[0].status, 'blocked');
  assert.equal(snapshot.pending_proposals[0].status, 'proposed_not_applied');
  assert.equal(snapshot.pending_proposals[0].items[0].fields.status, 'complete');
  assert.equal(snapshot.sources[0].relative_path, 'inputs/task-register.csv');
  assert.equal(Object.hasOwn(snapshot.sources[0], 'bytes'), false);
  assert.deepEqual(workspace, before);
});

test('Markdown brief uses accepted facts and source quotes, and excludes pending claims from facts', () => {
  const file = buildProjectExport(sampleWorkspace(), 'markdown', timestamp);
  assert.equal(file.contentType, 'text/markdown; charset=utf-8');
  assert.match(file.fileName, /-daily-brief\.md$/);
  assert.match(file.content, /Generated at: 2026-09-26T12:00:00\.000Z \(UTC\)/);
  assert.match(file.content, /Status: blocked/);
  assert.match(file.content, /Baseline date: 2026-10-20/);
  assert.match(file.content, /inputs\/task-register\.csv \(row 2\)/);
  assert.match(file.content, /T-501 remains blocked until the map index is checked/);
  assert.match(file.content, /Confirm the owner for Check the map index/);
  assert.match(file.content, /Resolve the dependency reference for Searchable atlas handover/);
  assert.match(file.content, /Calculated dependency path: Check the map index -> Searchable atlas handover\./);
  assert.doesNotMatch(file.content, /Pending status change|proposed completion claim|Status: complete/);
  assert.doesNotMatch(file.content, /probability|%/i);
});

test('Markdown explains an empty workspace without inventing project actions', () => {
  const workspace = sampleWorkspace();
  workspace.tasks = [];
  workspace.deliverables = [];
  workspace.dependencies = [];
  workspace.proposals = [];
  const file = buildProjectExport(workspace, 'markdown', timestamp);

  assert.match(file.content, /No accepted people, work, or deliverables are recorded yet/);
  assert.match(file.content, /No next action is inferred from the accepted project state/);
});
