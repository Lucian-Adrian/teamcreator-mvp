import assert from 'node:assert/strict';
import test from 'node:test';
import { collaborationProfileSchema, validateCollaborationReferences } from './collaboration-profile.js';
import { newProjectRecord } from '../server/reconcile.js';

const declared = { basis: 'declared', source_label: 'Declarație voluntară a membrului', recorded_on: '2026-09-27', soft_skills: ['Feedback concret'], working_preferences: 'Actualizări scrise', psychometric_method: null, psychometric_summary: null, compatibility: [] };

test('psychometric summaries require a supplied assessment and named method', () => {
  assert.equal(collaborationProfileSchema.safeParse(declared).success, true);
  assert.equal(collaborationProfileSchema.safeParse({ ...declared, psychometric_summary: 'Rezumat furnizat' }).success, false);
  assert.equal(collaborationProfileSchema.safeParse({ ...declared, basis: 'provided_assessment', psychometric_summary: 'Rezumat furnizat', psychometric_method: 'Evaluare voluntară' }).success, true);
});

test('collaboration notes reference another project member and do not repeat members', () => {
  const profile = collaborationProfileSchema.parse({ ...declared, compatibility: [{ member_id: 'colleague', note: 'Stabilim canalul de feedback.' }] });
  assert.doesNotThrow(() => validateCollaborationReferences(profile, [{ id: 'self' }, { id: 'colleague' }], 'self'));
  assert.throws(() => validateCollaborationReferences(profile, [{ id: 'self' }], 'self'));
  assert.throws(() => validateCollaborationReferences(profile, [{ id: 'colleague' }], 'colleague'));
  assert.equal(collaborationProfileSchema.safeParse({ ...profile, compatibility: [...profile.compatibility, ...profile.compatibility] }).success, false);
});

test('manual records preserve explicitly supplied collaboration and planning fields', () => {
  const profile = collaborationProfileSchema.parse(declared);
  const record = newProjectRecord({ kind: 'member', title: 'Membru sintetic', collaboration_profile: profile, documented_skills: ['Revizie'], availability_note: 'De confirmat', planned_start: '2026-10-01', planned_duration_days: 2, effort_hours: 12 });
  assert.deepEqual(record.collaboration_profile, profile);
  assert.deepEqual(record.documented_skills, ['Revizie']);
  assert.equal(record.availability_note, 'De confirmat');
  assert.equal(record.planned_start, '2026-10-01');
  assert.equal(record.planned_duration_days, 2);
  assert.equal(record.effort_hours, 12);
});
