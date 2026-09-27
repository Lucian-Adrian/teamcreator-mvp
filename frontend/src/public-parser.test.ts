import assert from 'node:assert/strict';
import test from 'node:test';
import { deterministicCandidates, parseStructuredText, readPublicFile } from './public-parser';

test('deterministic parser maps only recognized structured rows and preserves their citations', () => {
  const text = [
    'id,title,owner,status,target_date,depends_on',
    'T-01,Prepare technical plan,Elena Rusu,in_progress,2026-10-01,',
    'D-01,Approved plan,,planned,,T-01',
  ].join('\n');
  const rows = parseStructuredText(text, 'plan.csv');
  const candidates = deterministicCandidates(rows, 'source-1');

  assert.equal(candidates.length, 2);
  assert.equal(candidates[0].kind, 'task');
  assert.equal(candidates[0].title, 'Prepare technical plan');
  assert.equal(candidates[0].fields.owner, 'Elena Rusu');
  assert.equal(candidates[0].fields.due, '2026-10-01');
  assert.equal(candidates[0].source_refs[0].quote, 'T-01,Prepare technical plan,Elena Rusu,in_progress,2026-10-01,');
  assert.equal(candidates[1].kind, 'deliverable');
});

test('plain prose and unrelated tables do not create proposals', () => {
  assert.deepEqual(parseStructuredText('The supplier has not confirmed a delivery date.'), []);
  assert.deepEqual(parseStructuredText('color,value\nblue,3'), []);
});

test('unsupported public document formats remain inventoried without extracted text', async () => {
  const result = await readPublicFile(new File(['private sample'], 'brief.pdf', { type: 'application/pdf' }));
  assert.equal(result.parserStatus, 'unsupported');
  assert.equal(result.text, '');
  assert.match(result.error || '', /not sent to a server or provider/i);
});
