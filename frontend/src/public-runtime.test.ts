import assert from 'node:assert/strict';
import test from 'node:test';
import { createPublicApiHandler, type PublicAiRequest, type PublicRuntimeStore } from './public-runtime';
import type { PublicBrowserState } from './public-store';

class MemoryPublicStore implements PublicRuntimeStore {
  readonly idPrefix = 'public-test';
  state: PublicBrowserState = { schema: 1, browserId: 'test-browser-01', workspaces: [], sourceTexts: {}, requestReceipts: {} };
  failNextWrite = false;
  async initialize() {}
  async read<T>(read: (state: PublicBrowserState) => T): Promise<T> { return read(structuredClone(this.state)); }
  async transact<T>(change: (state: PublicBrowserState) => T): Promise<T> {
    const draft = structuredClone(this.state);
    const result = change(draft);
    if (this.failNextWrite) {
      this.failNextWrite = false;
      throw new DOMException('Browser storage quota exceeded.', 'QuotaExceededError');
    }
    this.state = draft;
    return result;
  }
}

const origin = 'https://live.example';
function api(store: MemoryPublicStore, options: Parameters<typeof createPublicApiHandler>[0] = {}) {
  return createPublicApiHandler(options, store, async () => new Response('unexpected network request', { status: 502 }));
}

async function send(handler: ReturnType<typeof createPublicApiHandler>, path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) {
  const request = new Request(`${origin}/api/${path}`, {
    method,
    headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const response = await handler(request);
  return { response, data: await response.json() };
}

async function upload(handler: ReturnType<typeof createPublicApiHandler>, projectId: string, content: string, name: string, key: string, headers: Record<string, string> = {}) {
  const form = new FormData();
  form.append('files', new File([content], name, { type: name.endsWith('.csv') ? 'text/csv' : 'text/plain' }));
  form.append('relative_paths', name);
  const request = new Request(`${origin}/api/projects/${projectId}/ingest`, {
    method: 'POST', headers: { 'Idempotency-Key': key, ...headers }, body: form,
  });
  const response = await handler(request);
  return { response, data: await response.json() };
}

async function createProject(handler: ReturnType<typeof createPublicApiHandler>, name: string) {
  const { response, data } = await send(handler, 'projects', 'POST', { name });
  assert.equal(response.status, 201);
  return data.project as { id: string };
}

test('public API supports cited upload, per-item correction/rejection, apply, reload, export and v1 import', async () => {
  const store = new MemoryPublicStore();
  const firstHandler = api(store);
  const project = await createProject(firstHandler, 'Structured test');
  const csv = [
    'id,title,owner,status,target_date,depends_on',
    'T-01,Prepare technical plan,Elena Rusu,in_progress,2026-10-01,',
    'T-02,Review the technical plan,Irina Ceban,not_started,,T-01',
  ].join('\n');
  const imported = await upload(firstHandler, project.id, csv, 'tasks.csv', 'key-upload-1');
  assert.equal(imported.response.status, 201);
  assert.equal(imported.data.extraction.provider_mode, 'degraded');
  assert.equal(imported.data.extraction.records_proposed, 2);
  const workspaceResult = await send(firstHandler, `projects/${project.id}/workspace`);
  const proposal = workspaceResult.data.proposals[0];
  const [first, second] = proposal.items;
  assert.equal(first.source_refs[0].quote, 'T-01,Prepare technical plan,Elena Rusu,in_progress,2026-10-01,');
  const repeated = await upload(firstHandler, project.id, csv, 'tasks.csv', 'key-upload-1');
  assert.equal(repeated.data.proposal.id, proposal.id);
  assert.equal((await send(firstHandler, `projects/${project.id}/workspace`)).data.sources.length, 1);

  const corrected = await send(firstHandler, `projects/${project.id}/proposals/${proposal.id}/items/${first.id}/review`, 'POST', {
    action: 'correct', reason: 'PM confirmed the exact work label.', fields: { title: 'Prepare revised technical plan' },
  });
  assert.equal(corrected.response.status, 200);
  const rejected = await send(firstHandler, `projects/${project.id}/proposals/${proposal.id}/items/${second.id}/review`, 'POST', {
    action: 'reject', reason: 'This row belongs to a later plan.',
  });
  assert.equal(rejected.response.status, 200);
  const applied = await send(firstHandler, `projects/${project.id}/proposals/${proposal.id}/apply`, 'POST', { itemIds: [first.id] });
  assert.equal(applied.response.status, 200);
  assert.equal(applied.data.applied, 1);

  // A new handler instance reads the same persisted browser state, as it would after reload.
  const reloadedHandler = api(store);
  const reloaded = await send(reloadedHandler, `projects/${project.id}/workspace`);
  assert.equal(reloaded.data.tasks.length, 1);
  assert.equal(reloaded.data.tasks[0].title, 'Prepare revised technical plan');
  assert.equal(reloaded.data.proposals.find((item: any) => item.id === proposal.id).status, 'applied');
  assert.ok(reloaded.data.proposals.some((item: any) => item.status === 'rejected'));
  const quoteRef = reloaded.data.tasks[0].source_refs[0];
  const quoteView = await send(reloadedHandler, `projects/${project.id}/sources/${quoteRef.source_id}/quote?quote=${encodeURIComponent(quoteRef.quote)}&location=${encodeURIComponent(quoteRef.location)}`);
  assert.equal(quoteView.data.exact_match, true);

  const otherProject = await createProject(reloadedHandler, 'Separate local project');
  await upload(reloadedHandler, otherProject.id, 'Confidential source text belongs to another project.', 'other.txt', 'key-other-project');

  const exported = await reloadedHandler(new Request(`${origin}/api/projects/${project.id}/export?format=json`));
  const snapshot = await exported.json();
  assert.equal(snapshot.schema, 'teamcreator-public-snapshot/v1');
  assert.deepEqual(Object.keys(snapshot.source_texts), [reloaded.data.sources[0].id]);
  const restored = await send(reloadedHandler, 'projects/import', 'POST', { snapshot });
  assert.equal(restored.response.status, 201);
  assert.notEqual(restored.data.project.id, project.id);
  const restoredWorkspace = await send(reloadedHandler, `projects/${restored.data.project.id}/workspace`);
  assert.equal(restoredWorkspace.data.tasks[0].title, 'Prepare revised technical plan');
  assert.ok(restoredWorkspace.data.audit.length >= reloaded.data.audit.length);
  const wrongVersion = await send(reloadedHandler, 'projects/import', 'POST', { snapshot: { ...snapshot, schema: 'teamcreator-public-snapshot/v2' } });
  assert.equal(wrongVersion.response.status, 400);
});

test('public AI failure leaves the source available without claiming proposals or model coverage', async () => {
  const store = new MemoryPublicStore();
  let received: PublicAiRequest | undefined;
  const handler = api(store, { ai: {
    status: async () => ({ configured: true, status: 'configured', model: 'test-model', message: 'Optional provider configured.' }),
    extract: async (input) => { received = input; throw new Error('Provider returned 429 rate limit.'); },
  } });
  const project = await createProject(handler, 'Provider boundary');
  const imported = await upload(handler, project.id, 'The supplier has not confirmed the date.', 'update.txt', 'key-upload-ai', { 'X-TeamCreator-AI': '1' });
  assert.equal(imported.response.status, 201);
  assert.equal(imported.data.extraction.records_proposed, 0);
  assert.match(imported.data.extraction.error, /429/);
  assert.equal(received?.documents.length, 1);
  const workspace = await send(handler, `projects/${project.id}/workspace`);
  assert.equal(workspace.data.sources.length, 1);
  assert.equal(workspace.data.sources[0].extraction_coverage, 'unavailable');
  assert.equal(workspace.data.proposals.length, 0);
  const provider = await send(handler, 'provider');
  assert.equal(provider.data.ai_configured, true);
  assert.match(provider.data.message, /only after you enable/i);
});

test('optional AI proposals keep only browser-verified item citations and dependency cycles fail atomically', async () => {
  const store = new MemoryPublicStore();
  const handler = api(store, { ai: {
    status: async () => ({ configured: true, status: 'configured', model: 'test-model', message: 'Optional provider configured.' }),
    extract: async (input) => ({
      provider_mode: 'model', provider_model: 'test-model', missing_info: [], items: [
        { record_kind: 'task', title: 'Confirm the delivery', record_id: null, fields: { status: 'needs_confirmation', owner: 'Dana' },
          source_refs: [{ source_id: input.documents[0].source_id, location: 'line 1', quote: 'The supplier confirmed the delivery date.' }] },
        { record_kind: 'task', title: 'Unsupported claim', record_id: null, fields: {},
          source_refs: [{ source_id: input.documents[0].source_id, location: 'line 1', quote: 'A fabricated source statement.' }] },
        { record_kind: 'member', title: 'Inferred profile', record_id: null, fields: { collaboration_profile: {
          basis: 'declared', source_label: 'Model guess', recorded_on: null, soft_skills: ['Reliable'], working_preferences: '',
          psychometric_method: null, psychometric_summary: null, compatibility: [],
        } }, source_refs: [{ source_id: input.documents[0].source_id, location: 'line 1', quote: 'The supplier confirmed the delivery date.' }] },
      ],
    }),
  } });
  const project = await createProject(handler, 'Citation and graph boundary');
  const text = 'The supplier confirmed the delivery date.';
  const imported = await upload(handler, project.id, text, 'supplier.txt', 'key-ai-valid', { 'X-TeamCreator-AI': '1' });
  assert.equal(imported.data.extraction.provider_mode, 'model');
  assert.equal(imported.data.extraction.records_proposed, 1);
  assert.match(imported.data.extraction.missing_info[0], /exact-quote validation/i);
  const workspace = await send(handler, `projects/${project.id}/workspace`);
  const proposal = workspace.data.proposals[0];
  assert.deepEqual(proposal.items[0].source_refs[0], { source_id: workspace.data.sources[0].id, location: 'line 1', quote: text });
  assert.equal(proposal.items[0].fields.field_refs, undefined);
  assert.equal(proposal.items.some((item: any) => item.title === 'Inferred profile'), false);
  assert.equal(workspace.data.sources[0].extraction_coverage, 'complete');
  const accepted = await send(handler, `projects/${project.id}/proposals/${proposal.id}/apply`, 'POST', { itemIds: [proposal.items[0].id] });
  assert.equal(accepted.response.status, 200);
  const afterAccept = await send(handler, `projects/${project.id}/workspace`);
  assert.deepEqual(afterAccept.data.tasks[0].field_refs, {});

  const taskA = await send(handler, `projects/${project.id}/records/tasks`, 'POST', { title: 'Task A' });
  const taskB = await send(handler, `projects/${project.id}/records/tasks`, 'POST', { title: 'Task B', depends_on: [taskA.data.record.id] });
  assert.equal(taskB.response.status, 201);
  const cycle = await send(handler, `projects/${project.id}/records/tasks/${taskA.data.record.id}`, 'PATCH', { depends_on: [taskB.data.record.id] });
  assert.equal(cycle.response.status, 400);
  const afterCycle = await send(handler, `projects/${project.id}/workspace`);
  assert.deepEqual(afterCycle.data.tasks.find((record: any) => record.id === taskA.data.record.id).depends_on, []);
});

test('failed browser storage writes do not leave an upload reported as saved', async () => {
  const store = new MemoryPublicStore();
  const handler = api(store);
  const project = await createProject(handler, 'Quota boundary');
  store.failNextWrite = true;
  const result = await upload(handler, project.id, 'id,title,owner,status\nT-1,Plan,Elena,in_progress', 'tasks.csv', 'key-quota');
  assert.equal(result.response.ok, false);
  assert.match(result.data.error, /quota/i);
  const workspace = await send(handler, `projects/${project.id}/workspace`);
  assert.equal(workspace.data.sources.length, 0);
});

test('public synthetic workspace keeps the expanded synthetic people and work fixture', async () => {
  const store = new MemoryPublicStore();
  const handler = api(store);
  const created = await send(handler, 'projects/demo', 'POST', {});
  assert.equal(created.response.status, 201);
  const workspace = await send(handler, `projects/${created.data.project.id}/workspace`);
  assert.equal(workspace.data.members.length, 7);
  assert.equal(workspace.data.tasks.length, 14);
  assert.equal(workspace.data.sources.length, 6);
  assert.equal(workspace.data.project.synthetic, true);
});

test('check-ins are saved as source text and do not invent facts from plain prose', async () => {
  const store = new MemoryPublicStore();
  const handler = api(store);
  const project = await createProject(handler, 'Check-in source');
  const checkin = await send(handler, `projects/${project.id}/checkins`, 'POST', {
    text: 'The manager said that the supplier has not confirmed a delivery date.', sourceName: 'weekly-update.txt',
  }, { 'Idempotency-Key': 'key-checkin-1' });
  assert.equal(checkin.response.status, 201);
  assert.equal(checkin.data.extraction.records_proposed, 0);
  assert.equal(checkin.data.sources[0].name, 'weekly-update.txt');
  const workspace = await send(handler, `projects/${project.id}/workspace`);
  assert.equal(workspace.data.proposals.length, 0);
  assert.equal(workspace.data.sources[0].extraction_coverage, 'unavailable');
  assert.match(workspace.data.sources[0].extraction_note, /No model ran/);
});

test('public manual and snapshot paths preserve validated collaboration and planning fields', async () => {
  const store = new MemoryPublicStore();
  const handler = api(store);
  const project = await createProject(handler, 'Profile fields');
  const first = await send(handler, `projects/${project.id}/records/members`, 'POST', { title: 'Elena', member_type: 'person' });
  assert.equal(first.response.status, 201);
  const profile = {
    basis: 'declared', source_label: 'Self-declared intake', recorded_on: '2026-09-27',
    soft_skills: ['Explains decisions', 'Coordinates handoffs'], working_preferences: 'Prefers written priorities.',
    psychometric_method: null, psychometric_summary: null,
    compatibility: [{ member_id: first.data.record.id, note: 'Both members named concise written updates as useful.' }],
  };
  const second = await send(handler, `projects/${project.id}/records/members`, 'POST', {
    title: 'Victor', member_type: 'person', collaboration_profile: profile,
    documented_skills: ['Electrical design'], availability_note: 'Four days each week through October 16.',
    planned_start: '2026-10-01', planned_duration_days: 3, effort_hours: 12,
  });
  assert.equal(second.response.status, 201);
  const workspace = await send(handler, `projects/${project.id}/workspace`);
  const victor = workspace.data.members.find((record: any) => record.id === second.data.record.id);
  assert.deepEqual(victor.collaboration_profile, profile);
  assert.deepEqual(victor.documented_skills, ['Electrical design']);
  assert.equal(victor.availability_note, 'Four days each week through October 16.');
  assert.equal(victor.planned_duration_days, 3);
  assert.equal(victor.effort_hours, 12);

  const wrongKind = await send(handler, `projects/${project.id}/records/tasks`, 'POST', { title: 'Wrong kind', collaboration_profile: profile });
  assert.equal(wrongKind.response.status, 400);
  const wrongKindNullProfile = await send(handler, `projects/${project.id}/records/tasks`, 'POST', { title: 'Wrong kind, null profile', collaboration_profile: null });
  assert.equal(wrongKindNullProfile.response.status, 400);
  const badReference = await send(handler, `projects/${project.id}/records/members/${second.data.record.id}`, 'PATCH', { collaboration_profile: { ...profile, compatibility: [{ member_id: 'outside-project', note: 'This reference is not in the project.' }] } });
  assert.equal(badReference.response.status, 400);
  const badPlan = await send(handler, `projects/${project.id}/records/tasks`, 'POST', { title: 'Bad plan', planned_duration_days: 100_001 });
  assert.equal(badPlan.response.status, 400);
  const badPlanDate = await send(handler, `projects/${project.id}/records/tasks`, 'POST', { title: 'Bad calendar date', planned_start: '2026-02-30' });
  assert.equal(badPlanDate.response.status, 400);
  const badSkills = await send(handler, `projects/${project.id}/records/members/${second.data.record.id}`, 'PATCH', { documented_skills: Array.from({ length: 17 }, (_, index) => `Skill ${index}`) });
  assert.equal(badSkills.response.status, 400);
  const nullSkills = await send(handler, `projects/${project.id}/records/members/${second.data.record.id}`, 'PATCH', { documented_skills: null });
  assert.equal(nullSkills.response.status, 400);

  const exported = await handler(new Request(`${origin}/api/projects/${project.id}/export?format=json`));
  const snapshot = await exported.json();
  const invalidDateSnapshot = JSON.parse(JSON.stringify(snapshot));
  invalidDateSnapshot.workspace.tasks.push({ id: 'invalid-date-task', kind: 'task', title: 'Invalid calendar date', planned_start: '2026-02-30' });
  const rejectedDateSnapshot = await send(handler, 'projects/import', 'POST', { snapshot: invalidDateSnapshot });
  assert.equal(rejectedDateSnapshot.response.status, 422);
  const nullSkillsSnapshot = JSON.parse(JSON.stringify(snapshot));
  nullSkillsSnapshot.workspace.members.find((record: any) => record.title === 'Victor').documented_skills = null;
  const rejectedSkillsSnapshot = await send(handler, 'projects/import', 'POST', { snapshot: nullSkillsSnapshot });
  assert.equal(rejectedSkillsSnapshot.response.status, 422);
  const nullProfileSnapshot = JSON.parse(JSON.stringify(snapshot));
  nullProfileSnapshot.workspace.tasks.push({ id: 'invalid-profile-task', kind: 'task', title: 'Non-member null profile', collaboration_profile: null });
  const rejectedProfileSnapshot = await send(handler, 'projects/import', 'POST', { snapshot: nullProfileSnapshot });
  assert.equal(rejectedProfileSnapshot.response.status, 422);
  const imported = await send(handler, 'projects/import', 'POST', { snapshot });
  assert.equal(imported.response.status, 201);
  const restored = await send(handler, `projects/${imported.data.project.id}/workspace`);
  const restoredVictor = restored.data.members.find((record: any) => record.title === 'Victor');
  const restoredElena = restored.data.members.find((record: any) => record.title === 'Elena');
  assert.deepEqual(restoredVictor.collaboration_profile, { ...profile, compatibility: [{ ...profile.compatibility[0], member_id: restoredElena.id }] });
  assert.deepEqual(restoredVictor.documented_skills, ['Electrical design']);
  assert.equal(restoredVictor.planned_start, '2026-10-01');
  assert.equal(restoredVictor.planned_duration_days, 3);
  assert.equal(restoredVictor.effort_hours, 12);
});
