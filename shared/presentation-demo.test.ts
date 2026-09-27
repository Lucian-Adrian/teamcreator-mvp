import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { buildSyntheticDemoWorkspace } from '../server/demo-fixture.js';
import { validateCollaborationReferences, collaborationProfileSchema } from './collaboration-profile.js';
import { findDependencyCycles } from '../server/impact.js';
import { createPresentationSimulationConfig, isPresentationDemo, PRESENTATION_DEMO_VERSION } from './presentation-demo.js';
import { createDefaultSimulationConfig, runSimulation } from './simulation.js';
import type { ProjectRecord, ProjectWorkspace, SourceRef } from './types.js';

function makeWorkspace(): ProjectWorkspace {
  return buildSyntheticDemoWorkspace('presentation-demo-test', '2026-09-27T00:00:00.000Z');
}

function remapWorkspaceRecordIds(workspace: ProjectWorkspace): ProjectWorkspace {
  const records: ProjectRecord[] = [
    ...workspace.members, ...workspace.tasks, ...workspace.deliverables, ...workspace.risks, ...workspace.decisions,
  ];
  const ids = new Map(records.map((record) => [record.id, randomUUID()]));
  const id = (value: string | null | undefined) => value ? ids.get(value) || value : value;
  const remapRecord = <T extends Partial<ProjectRecord>>(record: T): T => ({
    ...record,
    ...(record.id ? { id: id(record.id)! } : {}),
    ...(record.owner_id !== undefined ? { owner_id: id(record.owner_id) } : {}),
    ...(record.depends_on ? { depends_on: record.depends_on.map((dependency) => id(dependency)!) } : {}),
    ...(record.dependency_refs ? { dependency_refs: Object.fromEntries(Object.entries(record.dependency_refs).map(([dependency, refs]) => [id(dependency), refs])) } : {}),
    ...(record.collaboration_profile ? { collaboration_profile: {
      ...record.collaboration_profile,
      compatibility: record.collaboration_profile.compatibility.map((pair) => ({ ...pair, member_id: id(pair.member_id)! })),
    } } : {}),
  }) as T;
  const members = workspace.members.map((record) => remapRecord(record));
  const tasks = workspace.tasks.map((record) => remapRecord(record));
  const deliverables = workspace.deliverables.map((record) => remapRecord(record));
  const risks = workspace.risks.map((record) => remapRecord(record));
  const decisions = workspace.decisions.map((record) => remapRecord(record));
  return {
    ...workspace,
    members, tasks, deliverables, risks, decisions,
    dependencies: workspace.dependencies.map((edge) => ({ ...edge, from_id: id(edge.from_id)!, to_id: id(edge.to_id)!, id: `${id(edge.from_id)}:${id(edge.to_id)}` })),
    assignments: workspace.assignments.map((assignment) => ({ ...assignment, record_id: id(assignment.record_id)!, member_id: id(assignment.member_id)!, id: `${id(assignment.record_id)}:${id(assignment.member_id)}` })),
    proposals: workspace.proposals.map((proposal) => ({
      ...proposal,
      items: proposal.items.map((item) => ({
        ...item,
        record_id: item.record_id ? id(item.record_id)! : null,
        fields: remapRecord(item.fields),
        before: item.before ? remapRecord(item.before) : null,
      })),
    })),
    changes: workspace.changes.map((change) => ({ ...change })),
    audit: workspace.audit.map((event) => event.record_id ? ({ ...event, record_id: id(event.record_id)! }) : ({ ...event })),
    graph: { ...workspace.graph, cycles: workspace.graph.cycles.map((cycle) => cycle.map((recordId) => id(recordId)!)) },
  };
}

function allRecordRefs(workspace: ProjectWorkspace): SourceRef[] {
  const records: ProjectRecord[] = [
    ...workspace.members, ...workspace.tasks, ...workspace.deliverables, ...workspace.risks, ...workspace.decisions,
  ];
  return [
    ...records.flatMap((record) => [
      ...(record.source_refs || []),
      ...Object.values(record.field_refs || {}).flat(),
      ...Object.values(record.dependency_refs || {}).flat(),
    ]),
    ...workspace.dependencies.flatMap((dependency) => dependency.source_refs),
    ...workspace.proposals.flatMap((proposal) => proposal.items.flatMap((item) => item.source_refs)),
    ...workspace.changes.flatMap((change) => change.source_refs),
  ];
}

function assertExactSourceRefs(workspace: ProjectWorkspace): void {
  const sourceById = new Map(workspace.sources.map((source) => [source.id, source]));
  for (const ref of allRecordRefs(workspace)) {
    const source = sourceById.get(ref.source_id);
    assert.ok(source, `missing source ${ref.source_id}`);
    const line = /^line (\d+)$/.exec(ref.location);
    assert.ok(line, `invalid source location ${ref.location}`);
    assert.equal(source.excerpt?.split('\n')[Number(line[1]) - 1], ref.quote, `quote mismatch at ${source.name}:${ref.location}`);
  }
}

function assertProposalEvidence(workspace: ProjectWorkspace): void {
  const pending = workspace.proposals.find((proposal) => proposal.status === 'proposed');
  assert.ok(pending && pending.items.length >= 2);
  assert.equal(new Set(pending.items.flatMap((item) => item.source_refs.map((ref) => ref.source_id))).size, 2);
  assert.ok(pending.items.every((item) => item.review_state === 'unreviewed' && item.source_refs.every((ref) => pending.source_ids.includes(ref.source_id))));

  const optionSource = workspace.sources.find((source) => source.name === '10-review-options.md')!;
  const registerSource = workspace.sources.find((source) => source.name === '07-project-register.md')!;
  const optionLine = (lineNumber: number) => optionSource.excerpt!.split('\n')[lineNumber - 1];
  const first = pending.items.find((item) => item.id === 'pr-item-t14-window')!;
  const firstQuote = optionLine(2);
  assert.deepEqual(first.source_refs.map((ref) => [ref.source_id, ref.location, ref.quote]), [[optionSource.id, 'line 2', firstQuote]]);
  assert.equal(first.fields.planned_start, firstQuote.match(/\d{4}-\d{2}-\d{2}/)?.[0]);
  assert.equal(first.fields.planned_duration_days, /o zi de lucru/.test(firstQuote) ? 1 : null);
  assert.equal(first.fields.effort_hours, /două ore de efort/.test(firstQuote) ? 2 : null);

  const second = pending.items.find((item) => item.id === 'pr-item-post-install-check')!;
  const secondQuote = optionLine(3);
  const registerT20 = registerSource.excerpt!.split('\n')[9];
  assert.deepEqual(second.source_refs.map((ref) => [ref.source_id, ref.location, ref.quote]), [
    [optionSource.id, 'line 3', secondQuote], [registerSource.id, 'line 10', registerT20],
  ]);
  assert.equal(second.fields.title, second.title);
  assert.equal(second.fields.owner, 'Oleg Balan');
  assert.equal(second.fields.owner_id, workspace.members.find((member) => member.title === 'Oleg Balan')?.id);
  assert.equal(second.fields.planned_start, secondQuote.match(/\d{4}-\d{2}-\d{2}/)?.[0]);
  assert.equal(second.fields.due, second.fields.planned_start);
  assert.equal(second.fields.planned_duration_days, /durata estimată este o zi/.test(secondQuote) ? 1 : null);
  assert.equal(second.fields.effort_hours, /efortul patru ore/.test(secondQuote) ? 4 : null);
  assert.equal(second.fields.due_basis, 'forecast');
  assert.ok((second.fields.depends_on || []).length === 1 && secondQuote.includes('după verificarea T-20') && registerT20.includes('T-20'));
}

test('presentation fixture is a complete, source-resolved, cycle-free synthetic project', () => {
  const workspace = makeWorkspace();
  assert.equal(workspace.project.name, 'Iluminat stradal · Bălți · prezentare');
  assert.match(workspace.project.description || '', new RegExp(PRESENTATION_DEMO_VERSION.replaceAll('.', '\\.')));
  assert.equal(isPresentationDemo(workspace), true);
  assert.equal(isPresentationDemo(workspace.project), true);
  assert.equal(isPresentationDemo({ ...workspace.project, name: 'Alt proiect' }), false);
  assert.deepEqual([workspace.members.length, workspace.tasks.length, workspace.deliverables.length], [10, 20, 3]);
  assert.equal(workspace.risks.length, 3);
  assert.equal(workspace.decisions.length, 3);
  assert.deepEqual(findDependencyCycles(workspace), []);
  assert.equal(workspace.graph.has_cycles, false);

  assertExactSourceRefs(workspace);

  const memberIds = new Set(workspace.members.map((member) => member.id));
  for (const member of workspace.members) {
    const profile = collaborationProfileSchema.parse(member.collaboration_profile);
    validateCollaborationReferences(profile, workspace.members, member.id);
    for (const pair of profile.compatibility) assert.ok(memberIds.has(pair.member_id));
  }

  const completions = workspace.tasks.filter((task) => task.completed_at).map((task) => task.completed_at!);
  assert.equal(completions.length, 5);
  assert.equal(new Set(completions).size, 5);
  assert.ok(workspace.sources.every((source) => source.parse_coverage === 'complete' && source.extraction_coverage === 'complete'));
  assertProposalEvidence(workspace);
});

test('packaged browser workspace matches the versioned source-backed presentation fixture', () => {
  const workspace = JSON.parse(readFileSync(new URL('../frontend/src/public-demo-fixture.json', import.meta.url), 'utf8')) as ProjectWorkspace;
  assert.equal(isPresentationDemo(workspace), true);
  assert.deepEqual([workspace.members.length, workspace.tasks.length, workspace.deliverables.length], [10, 20, 3]);
  assert.equal(workspace.proposals[0]?.items.length, 2);
  assertExactSourceRefs(workspace);
  assertProposalEvidence(workspace);
});

test('presentation preset is deterministic input, valid for the fixture, and explicitly synthetic', async () => {
  const workspace = makeWorkspace();
  const config = createPresentationSimulationConfig(workspace);
  assert.equal(config.iterations, 10_000);
  assert.equal(config.seed, 20260927);
  assert.deepEqual(config.calendar, { startDate: '2026-09-28', workingWeekdays: [1, 2, 3, 4, 5], holidays: [], deadlineDate: '2026-10-30' });
  assert.equal(config.commonRisks.length, 3);
  const activeIds = new Set(workspace.tasks.filter((task) => !task.completed_at).map((task) => task.id));
  assert.ok(Object.entries(config.estimates).filter(([id]) => activeIds.has(id)).every(([, estimate]) => estimate.rationale?.includes('Ipoteză manuală')));
  assert.ok(Object.values(config.memberCapacity).every((capacity) => capacity.confirmed === false));
  assert.throws(() => createPresentationSimulationConfig({ ...workspace, project: { ...workspace.project, name: 'Alt proiect' } }));

  const smallRun = await runSimulation(workspace, { ...config, iterations: 100 });
  assert.equal(smallRun.iterations, 100);
  assert.equal(smallRun.paths.length, 24);
  assert.equal(smallRun.deadlineOutlook?.sampleCount, 100);
});

test('presentation preset resolves cloned IDs and leaves added/renamed tasks and members at defaults', async () => {
  const original = makeWorkspace();
  const workspace = remapWorkspaceRecordIds(original);
  const taskIdByTitle = new Map(workspace.tasks.map((task) => [task.title, task.id]));
  const memberIdByTitle = new Map(workspace.members.map((member) => [member.title, member.id]));
  const newMemberId = randomUUID();
  workspace.members.push({
    ...workspace.members[0], id: newMemberId, title: 'Membru adăugat', owner: null, owner_id: null,
    documented_skills: [], availability_note: null, collaboration_profile: null, source_refs: [], field_refs: {},
  });
  const newTaskId = randomUUID();
  workspace.tasks.push({
    ...workspace.tasks[0], id: newTaskId, title: 'Sarcină adăugată după clonare', owner: 'Membru adăugat', owner_id: newMemberId,
    status: 'not_started', due: null, due_basis: 'unknown', completed_at: null, planned_start: null,
    planned_duration_days: null, effort_hours: null, depends_on: [], dependency_refs: {}, source_refs: [], field_refs: {},
  });
  workspace.assignments.push({ id: `${newTaskId}:${newMemberId}`, record_id: newTaskId, member_id: newMemberId, evidence_state: 'derived_by_rule', source_refs: [] });

  const config = createPresentationSimulationConfig(workspace);
  assert.equal(config.iterations, 10_000);
  assert.deepEqual(config.estimates[taskIdByTitle.get('Pregătește planul tehnic intermediar')!], {
    min: 2, mode: 3, max: 5, basis: 'placeholder', confirmed: false,
    rationale: 'Ipoteză manuală, editabilă, pentru prezentarea sintetică; nu este o durată observată sau confirmată de un client.',
  });
  assert.deepEqual(config.estimates[newTaskId], createDefaultSimulationConfig(workspace).estimates[newTaskId]);
  assert.deepEqual(config.memberCapacity[newMemberId], createDefaultSimulationConfig(workspace).memberCapacity[newMemberId]);
  const allTaskIds = new Set(workspace.tasks.map((task) => task.id));
  assert.ok(config.commonRisks.every((risk) => risk.taskIds.every((taskId) => allTaskIds.has(taskId))));
  assert.ok(config.commonRisks.some((risk) => risk.taskIds.includes(taskIdByTitle.get('Confirmă data livrării cu furnizorul')!)));
  assert.ok(config.memberCapacity[memberIdByTitle.get('Elena Rusu')!]);

  const smallRun = await runSimulation(workspace, { ...config, iterations: 100 });
  assert.equal(smallRun.iterations, 100);
});
