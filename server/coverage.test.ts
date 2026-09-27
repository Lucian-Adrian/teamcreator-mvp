import assert from 'node:assert/strict';
import test from 'node:test';
import type { ProjectSource } from '../shared/types.js';
import { extractionCoverage, nextSourceBatch, splitSourceText } from './coverage.js';

function source(id: string, createdAt: string): ProjectSource {
  return {
    id, name: `${id}.md`, sha256: 'a'.repeat(64), size: 10, media_type: 'text/markdown', parser_status: 'parsed',
    created_at: createdAt, parse_coverage: 'complete', extraction_coverage: 'pending', processed_segments: [],
  };
}

test('splits retained text without gaps and chooses one segment per source before continuing a long source', () => {
  const original = `${'a'.repeat(11_900)}\n${'b'.repeat(15_000)}\n${'c'.repeat(14_000)}`;
  const segments = splitSourceText(original, 12_000);
  assert.equal(segments.map((segment) => segment.text).join(''), original);
  assert.equal(segments[0].start_offset, 0);
  assert.equal(segments.at(-1)?.end_offset, original.length);
  assert.ok(segments.every((segment) => segment.text.length <= 12_000));

  const first = source('source-a', '2026-01-01T00:00:00.000Z');
  const second = source('source-b', '2026-01-02T00:00:00.000Z');
  const batch = nextSourceBatch([first, second], new Map([[first.id, original], [second.id, 'short source']]), 3);
  assert.deepEqual(batch.map((segment) => `${segment.source_id}:${segment.index}`), [
    'source-a:0', 'source-b:0', 'source-a:1',
  ]);
});

test('coverage ledger represents only validated segment indices and leaves remaining work visible', () => {
  const text = 'x'.repeat(30_001);
  const item = source('source-ledger', '2026-01-01T00:00:00.000Z');
  const total = splitSourceText(text).length;
  assert.equal(total, 3);
  assert.equal(extractionCoverage(item, [0, 0, 20], text).extraction_coverage, 'partial');
  assert.deepEqual(extractionCoverage(item, [2, 0, 1], text).processed_segments, [0, 1, 2]);
  assert.equal(extractionCoverage(item, [2, 0, 1], text).extraction_coverage, 'complete');
  assert.equal(extractionCoverage({ ...item, extraction_coverage: 'legacy_unknown' }, [], text).extraction_coverage, 'legacy_unknown');
});
