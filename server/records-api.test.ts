import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

test('manual API persists planning and declared profiles, rejects invalid references, and keeps audit evidence', async () => {
  const temporaryRoot = path.resolve(os.tmpdir());
  const directory = await mkdtemp(path.join(temporaryRoot, 'tc-record-fields-test-'));
  process.env.TC_GIGAHACK_DATA_DIR = directory;
  process.env.TC_API_NO_LISTEN = '1';
  const { app, store } = await import('./index.js');
  await store.initialize();
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const request = async (route: string, method: string, body?: unknown) => {
    const response = await fetch(`http://127.0.0.1:${address.port}/api${route}`, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, body: await response.json() };
  };
  try {
    const created = await request('/projects', 'POST', { name: 'Test sintetic câmpuri manuale' });
    assert.equal(created.status, 201);
    const prefix = `/projects/${created.body.project.id}`;
    const member = await request(`${prefix}/records/members`, 'POST', { title: 'Membru sintetic', documented_skills: ['Revizie'], availability_note: 'De confirmat' });
    assert.equal(member.status, 201);
    const profile = { basis: 'declared', source_label: 'Declarație voluntară sintetică', recorded_on: '2026-09-27', soft_skills: ['Feedback concret'], working_preferences: 'Mesaje scrise', psychometric_method: null, psychometric_summary: null, compatibility: [] };
    const saved = await request(`${prefix}/records/members/${member.body.record.id}`, 'PATCH', { collaboration_profile: profile, reason: 'Test sintetic' });
    assert.equal(saved.status, 200);
    assert.deepEqual(saved.body.record.collaboration_profile, profile);
    const task = await request(`${prefix}/records/tasks`, 'POST', { title: 'Sarcină sintetică', planned_start: '2026-10-01', planned_duration_days: 3, effort_hours: 16 });
    assert.equal(task.status, 201);
    assert.equal(task.body.record.effort_hours, 16);
    assert.equal((await request(`${prefix}/records/tasks/${task.body.record.id}`, 'PATCH', { collaboration_profile: profile })).status, 400);
    assert.equal((await request(`${prefix}/records/members/${member.body.record.id}`, 'PATCH', { collaboration_profile: { ...profile, compatibility: [{ member_id: 'missing', note: 'Nu există în proiect.' }] } })).status, 400);
    const workspace = await store.getWorkspace(created.body.project.id);
    assert.ok(workspace);
    assert.ok(workspace.audit.some(event => event.type === 'record_edited' && Boolean((event.after as { collaboration_profile?: unknown } | null)?.collaboration_profile)));
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    const resolved = path.resolve(directory);
    assert.ok(resolved.startsWith(temporaryRoot + path.sep) && path.basename(resolved).startsWith('tc-record-fields-test-'));
    await rm(resolved, { recursive: true, force: true });
  }
});
