import assert from 'node:assert/strict';
import test from 'node:test';
import type { SourceRef } from '../shared/types.js';
import { validateSourceQuote, type ExtractionDocument } from './provider.js';

test('validates evidence against any supplied segment for a repeated source ID', () => {
  const segments: ExtractionDocument[] = [
    { source_id: 'source-long', name: 'held-out.txt (segment 5 of 7)', text: '[held-out.txt, line 400]: T-900 is still in progress.' },
    { source_id: 'source-long', name: 'held-out.txt (segment 6 of 7)', text: '[held-out.txt, line 450]: The checksum is complete.' },
    { source_id: 'source-long', name: 'held-out.txt (segment 7 of 7)', text: '[held-out.txt, line 505]: D-900 has an approved baseline; depends on T-901.' },
  ];
  const lastSegmentQuote: SourceRef = {
    source_id: 'source-long',
    location: 'held-out.txt, line 505',
    quote: 'D-900 has an approved baseline; depends on T-901.',
  };
  assert.equal(validateSourceQuote(lastSegmentQuote, segments), true);
  assert.equal(validateSourceQuote({ ...lastSegmentQuote, quote: 'D-900 has an approved baseline' }, segments), true);
  assert.equal(validateSourceQuote({ ...lastSegmentQuote, quote: 'D-900 has an approved baseline, depends on T-901.' }, segments), false);
  assert.equal(validateSourceQuote({ ...lastSegmentQuote, source_id: 'other-source' }, segments), false);
});
