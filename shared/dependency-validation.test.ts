import assert from 'node:assert/strict';
import test from 'node:test';
import { findTaskDependencyCycle, normalizeSourceRefLocation } from './dependency-validation';

test('finds cycles introduced across task and deliverable overrides', () => {
  const records = [
    { id: 'task-a', kind: 'task' as const, depends_on: [] },
    { id: 'task-b', kind: 'task' as const, depends_on: [] },
    { id: 'gate', kind: 'deliverable' as const, depends_on: [] },
  ];
  const cycle = findTaskDependencyCycle(records, { 'task-a': ['gate'], gate: ['task-b'], 'task-b': ['task-a'] });
  assert.deepEqual(cycle, ['gate', 'task-b', 'task-a', 'gate']);
  assert.equal(findTaskDependencyCycle(records, { 'task-a': ['task-b'] }), null);
});

test('normalizes a citation to the actual matched source line and preserves valid duplicate locations', () => {
  const source = '[plan.txt, line 1]: Intro\n[plan.txt, line 2]: Repeated commitment\n[plan.txt, line 3]: Repeated commitment';
  const wrong = normalizeSourceRefLocation(source, { source_id: 'source-1', location: 'line 99', quote: 'Repeated commitment' });
  const validDuplicate = normalizeSourceRefLocation(source, { source_id: 'source-1', location: 'line 3', quote: 'Repeated commitment' });
  assert.equal(wrong?.location, 'line 2');
  assert.equal(validDuplicate?.location, 'line 3');
  assert.equal(normalizeSourceRefLocation(source, { source_id: 'source-1', location: 'line 1', quote: 'Absent quote' }), null);
});

test('retains parsed sheet and row anchors for table evidence', () => {
  const normalized = normalizeSourceRefLocation('[plan.xlsx, sheet Work, row 7]: Review quantities', {
    source_id: 'source-sheet', location: 'row 4', quote: 'Review quantities',
  });
  assert.equal(normalized?.location, 'sheet Work, row 7');
});
