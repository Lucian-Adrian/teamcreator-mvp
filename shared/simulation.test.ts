import assert from 'node:assert/strict';
import test from 'node:test';
import type { ProjectRecord, ProjectWorkspace } from './types';
import {
  compareSimulation,
  createDefaultSimulationConfig,
  runSimulation,
  summarizeDeadlineOutlook,
  summarizeRemainingWorkSamples,
  workingDateAtOffset,
  SimulationValidationError,
  type SimulationConfig,
} from './simulation';

function record(id: string, kind: 'task' | 'deliverable' = 'task', dependsOn: string[] = [], ownerId: string | null = null, completedAt: string | null = null): ProjectRecord {
  return {
    id, kind, title: id.toUpperCase(), status: completedAt ? 'done' : 'in_progress', owner: ownerId ? 'Ana' : null,
    owner_id: ownerId, due: null, completed_at: completedAt, depends_on: dependsOn, source_refs: [],
    evidence_state: 'not_found', review_state: 'unreviewed', created_at: '2026-09-27T00:00:00.000Z', updated_at: '2026-09-27T00:00:00.000Z',
  };
}

function workspace(tasks: ProjectRecord[], deliverables: ProjectRecord[] = [], assignedTaskIds: string[] = []): ProjectWorkspace {
  const member = record('member-ana', 'task');
  member.kind = 'member';
  member.title = 'Ana';
  member.member_type = 'person';
  return {
    project: { id: 'project-test', name: 'Test', created_at: '2026-09-27T00:00:00.000Z', updated_at: '2026-09-27T00:00:00.000Z', synthetic: true },
    members: [member], tasks, deliverables, risks: [], decisions: [],
    dependencies: [...tasks, ...deliverables].flatMap((item) => item.depends_on.map((prerequisite) => ({ id: `${item.id}:${prerequisite}`, from_id: item.id, to_id: prerequisite, evidence_state: 'derived_by_rule' as const, source_refs: [] }))),
    assignments: assignedTaskIds.map((record_id) => ({ id: `${record_id}:member-ana`, record_id, member_id: 'member-ana', evidence_state: 'derived_by_rule' as const, source_refs: [] })),
    sources: [], proposals: [], changes: [], audit: [], graph: { cycles: [], has_cycles: false },
  };
}

function fixedConfig(project: ProjectWorkspace, taskDays: Record<string, number>, iterations = 400): SimulationConfig {
  const config = createDefaultSimulationConfig(project);
  config.iterations = iterations;
  config.seed = 47;
  for (const [taskId, days] of Object.entries(taskDays)) config.estimates[taskId] = { min: days, mode: days, max: days, basis: 'manager_estimate', confirmed: true };
  for (const capacity of Object.values(config.memberCapacity)) capacity.confirmed = true;
  return config;
}

function empiricalPercentile(values: number[], quantile: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * quantile;
  const low = Math.floor(position);
  const high = Math.ceil(position);
  return low === high ? sorted[low] : sorted[low] + (sorted[high] - sorted[low]) * (position - low);
}

test('fixed seed produces identical completion draws and selected paths', async () => {
  const project = workspace([record('a'), record('b', 'task', ['a'])]);
  const config = fixedConfig(project, { a: 2, b: 3 });
  const first = await runSimulation(project, config);
  const second = await runSimulation(project, config);
  assert.deepEqual(first.completionDays, second.completionDays);
  assert.deepEqual(first.histogram, second.histogram);
  assert.deepEqual(first.paths, second.paths);
  assert.equal(first.modelVersion, '1.2.2');
  assert.equal(first.paths.length, 24);
  assert.equal(new Set(first.paths.map(path => path.iteration)).size, first.paths.length);
  assert.ok(first.paths.every((path, index) => index === 0 || path.targetQuantile >= first.paths[index - 1].targetQuantile));
  assert.equal(first.families.reduce((sum, family) => sum + family.sampleCount, 0), config.iterations);
  assert.equal(createDefaultSimulationConfig(project).iterations, 10_000);
  assert.equal(first.workspaceFingerprint, second.workspaceFingerprint);
  assert.equal(first.configFingerprint, second.configFingerprint);
  assert.equal(first.completionDays.p50, 5);

  const changedProject = workspace([record('a'), record('b', 'task', ['a'])]);
  changedProject.tasks[0].title = 'Changed source-backed task';
  const changed = await runSimulation(changedProject, config);
  assert.notEqual(changed.workspaceFingerprint, first.workspaceFingerprint);
  assert.equal(changed.configFingerprint, first.configFingerprint);
});

test('calendar labels and deadline buckets use the configured workweek and holidays', () => {
  const calendar = {
    startDate: '2026-09-25', // Friday
    workingWeekdays: [1, 2, 3, 4, 5],
    holidays: ['2026-09-28'],
    deadlineDate: '2026-09-25',
  };
  assert.equal(workingDateAtOffset(calendar, 1), '2026-09-25');
  assert.equal(workingDateAtOffset(calendar, 2), '2026-09-29');
  assert.equal(workingDateAtOffset(calendar, 5), '2026-10-02');

  const outlook = summarizeDeadlineOutlook([1, 2, 3, 4, 5, 6], calendar)!;
  assert.deepEqual([
    outlook.onTime.count,
    outlook.lateUpTo7Days.count,
    outlook.lateMoreThan7Days.count,
  ], [1, 4, 1]);
  assert.equal(outlook.onTime.count + outlook.lateUpTo7Days.count + outlook.lateMoreThan7Days.count, outlook.sampleCount);
  assert.ok(Math.abs(outlook.onTime.share + outlook.lateUpTo7Days.share + outlook.lateMoreThan7Days.share - 1) < 1e-12);
  assert.equal(summarizeDeadlineOutlook([1], { ...calendar, deadlineDate: null }), null);
});

test('resource capacity serializes otherwise parallel work and reports the queue proxy', async () => {
  const project = workspace([record('a', 'task', [], 'member-ana'), record('b', 'task', [], 'member-ana')], [], ['a', 'b']);
  const config = fixedConfig(project, { a: 2, b: 3 });
  const result = await runSimulation(project, config);
  const median = result.paths.reduce((best, candidate) => Math.abs(candidate.targetQuantile - 50) < Math.abs(best.targetQuantile - 50) ? candidate : best);
  const secondTask = median.tasks.find((task) => task.id === 'b')!;
  assert.equal(result.completionDays.p50, 5);
  assert.equal(secondTask.startDays, 2);
  assert.equal(result.metrics.capacityQueueDays.p50, 2);
});

test('deliverable milestones wait for their task prerequisites', async () => {
  const project = workspace([record('build'), record('review', 'task', ['gate'])], [record('gate', 'deliverable', ['build'])]);
  const config = fixedConfig(project, { build: 2, review: 1 });
  const result = await runSimulation(project, config);
  const median = result.paths.reduce((best, candidate) => Math.abs(candidate.targetQuantile - 50) < Math.abs(best.targetQuantile - 50) ? candidate : best);
  assert.equal(median.tasks.find((task) => task.id === 'review')!.startDays, 2);
  assert.equal(result.completionDays.p50, 3);
});

test('zero-duration owned milestones bypass member concurrency and release dependants immediately', async () => {
  const project = workspace(
    [record('build', 'task', [], 'member-ana'), record('follow-up', 'task', ['gate'])],
    [record('gate', 'deliverable', [], 'member-ana')],
    ['build'],
  );
  const config = fixedConfig(project, { build: 5, 'follow-up': 1 });
  config.memberCapacity['member-ana'].maxConcurrentTasks = 1;
  const result = await runSimulation(project, config);
  const path = result.paths.reduce((best, candidate) => Math.abs(candidate.targetQuantile - 50) < Math.abs(best.targetQuantile - 50) ? candidate : best);
  assert.equal(path.tasks.find((item) => item.id === 'gate')!.finishDays, 0);
  assert.equal(path.tasks.find((item) => item.id === 'follow-up')!.startDays, 0);
  assert.equal(result.completionDays.p50, 5);
});

test('one shared risk draw applies its multiplier to every selected task', async () => {
  const project = workspace([record('a'), record('b')]);
  const config = fixedConfig(project, { a: 2, b: 4 });
  config.commonRisks = [{ id: 'shared', label: 'Furnizor comun', taskIds: ['a', 'b'], probability: 1, durationMultiplier: { min: 2, mode: 2, max: 2 } }];
  const result = await runSimulation(project, config);
  assert.equal(result.tasks.find((item) => item.taskId === 'a')!.durationDays.p50, 4);
  assert.equal(result.tasks.find((item) => item.taskId === 'b')!.durationDays.p50, 8);
});

test('duplicate common-risk IDs and duplicate task scopes are rejected', async () => {
  const project = workspace([record('a')]);
  const config = fixedConfig(project, { a: 2 });
  config.commonRisks = [{ id: 'shared', label: 'Shared', taskIds: ['a', 'a'], probability: 1, durationMultiplier: { min: 2, mode: 2, max: 2 } }];
  await assert.rejects(runSimulation(project, config), (error: unknown) => error instanceof SimulationValidationError && error.details.some((detail) => detail.includes('listează de mai multe ori sarcina a')));

  config.commonRisks = [
    { id: 'shared', label: 'Shared 1', taskIds: ['a'], probability: 1, durationMultiplier: { min: 2, mode: 2, max: 2 } },
    { id: 'shared', label: 'Shared 2', taskIds: ['a'], probability: 1, durationMultiplier: { min: 2, mode: 2, max: 2 } },
  ];
  await assert.rejects(runSimulation(project, config), (error: unknown) => error instanceof SimulationValidationError && error.details.some((detail) => detail.includes('factorului comun „shared” este duplicat')));
});

test('cycle and invalid estimate are rejected before simulation', async () => {
  const cycleProject = workspace([record('a', 'task', ['b']), record('b', 'task', ['a'])]);
  await assert.rejects(runSimulation(cycleProject, fixedConfig(cycleProject, { a: 1, b: 1 })), SimulationValidationError);

  const project = workspace([record('a')]);
  const config = fixedConfig(project, { a: 2 });
  config.estimates.a = { min: 4, mode: 2, max: 8, basis: 'manager_estimate', confirmed: true };
  await assert.rejects(runSimulation(project, config), /Corectează intrările simulării/);
});

test('intervention comparison pairs the same draws and returns the observed delta distribution', async () => {
  const project = workspace([record('a')]);
  const config = fixedConfig(project, { a: 2 });
  const comparison = await compareSimulation(project, config, { kind: 'duration_shift', taskId: 'a', days: 1, label: 'Add one day' });
  assert.equal(comparison.sameRandomDraws, true);
  assert.equal(comparison.baseline.completionDays.p50, 2);
  assert.equal(comparison.scenario.completionDays.p50, 3);
  assert.deepEqual(comparison.completionDeltaDays, { p10: 1, p50: 1, p80: 1, p90: 1 });
  assert.equal(comparison.probabilityOfFasterFinish, 0);
});

test('chunked run observes cancellation after yielding progress', async () => {
  const project = workspace([record('a')]);
  const config = fixedConfig(project, { a: 2 }, 1000);
  const controller = new AbortController();
  await assert.rejects(runSimulation(project, config, {
    signal: controller.signal,
    chunkSize: 10,
    onProgress: (progress) => { if (progress.completed === 10) controller.abort(); },
  }), (error: unknown) => error instanceof Error && error.name === 'AbortError');
});


test('sampled trajectories use actual empirical ranks and family membership', async () => {
  const project = workspace([record('a'), record('b', 'task', ['a'])]);
  const config = createDefaultSimulationConfig(project);
  config.iterations = 1000;
  config.seed = 42;
  config.calendar.deadlineDate = '2026-10-30';
  const result = await runSimulation(project, config);
  assert.equal(result.paths.length, 24);
  for (let index = 1; index < result.paths.length; index++) {
    assert.ok(result.paths[index].completionDays >= result.paths[index - 1].completionDays);
    assert.ok(result.paths[index].targetQuantile >= result.paths[index - 1].targetQuantile);
  }
  for (const path of result.paths) {
    if (path.targetQuantile >= 91) assert.ok(path.completionDays >= result.completionDays.p90);
    if (path.targetQuantile <= 9) assert.ok(path.completionDays <= result.completionDays.p10);
    if (path.familyId === 'shorter') assert.ok(path.completionDays <= result.completionDays.p50);
    if (path.familyId === 'later') assert.ok(path.completionDays >= result.completionDays.p50);
  }
  assert.equal(result.deadlineOutlook!.onTime.count + result.deadlineOutlook!.lateUpTo7Days.count + result.deadlineOutlook!.lateMoreThan7Days.count, 1000);
});

test('remaining work forecast uses joint full-sample ranks, reviewed effort units, and completion boundaries', async () => {
  const finishesA = Array.from({ length: 16 }, (_, index) => index < 10 ? 9 : 1);
  const finishesB = Array.from({ length: 16 }, (_, index) => index < 6 || (index >= 10 && index < 14) ? 9 : 1);
  const paired = await summarizeRemainingWorkSamples([finishesA, finishesB], [1, 1], [0, 5, 9], 16);
  const perTaskMedians = [finishesA, finishesB].reduce((sum, finishes) => sum + empiricalPercentile(finishes.map((finish) => Number(finish > 5)), 0.5), 0);
  assert.equal(paired[1].p50, 1);
  assert.equal(perTaskMedians, 2);
  assert.notEqual(paired[1].p50, perTaskMedians);
  assert.deepEqual(paired[0], { p10: 2, p50: 2, p90: 2 });
  assert.deepEqual(paired[2], { p10: 0, p50: 0, p90: 0 });

  const project = workspace([record('a'), record('b'), record('already-done', 'task', [], null, '2026-09-27T00:00:00.000Z')], [record('gate', 'deliverable', ['a', 'b'])]);
  const config = fixedConfig(project, { a: 8, b: 8 }, 100);
  config.estimates.a = { min: 2, mode: 8, max: 14, basis: 'manager_estimate', confirmed: true };
  config.estimates.b = { min: 2, mode: 8, max: 14, basis: 'manager_estimate', confirmed: true };
  const result = await runSimulation(project, config);
  const forecast = result.remainingWorkForecast!;
  assert.deepEqual({ unit: forecast.unit, scope: forecast.scope, milestonesExcluded: forecast.milestonesExcluded }, {
    unit: 'tasks', scope: 'active_task_scope_at_simulation_start', milestonesExcluded: true,
  });
  assert.deepEqual(forecast.effortCoverage, { confirmedTaskCount: 0, totalTaskCount: 2 });
  assert.equal(forecast.points.length, 32);
  assert.equal(forecast.points[0].workingDays, 0);
  assert.ok(forecast.points.at(-1)!.workingDays >= result.completionDays.p90);
  assert.deepEqual(forecast.points.at(-1)!.remaining, { p10: 0, p50: 0, p90: 0 });

  const hoursProject = workspace([record('c'), record('d')], [record('milestone', 'deliverable', ['c'])]);
  const citation = { source_id: 'effort-source', location: 'line 1', quote: 'Effort is confirmed at five hours.' };
  hoursProject.sources.push({ id: 'effort-source', name: 'effort.txt', sha256: 'abc', size: 40, media_type: 'text/plain', parser_status: 'parsed', created_at: '2026-09-27T00:00:00.000Z' });
  const [taskC, taskD] = hoursProject.tasks;
  Object.assign(taskC, { effort_hours: 5, review_state: 'manager_confirmed', evidence_state: 'supported', field_refs: { effort_hours: [citation] } });
  Object.assign(taskD, { effort_hours: 7, review_state: 'manager_corrected', evidence_state: 'expert_observation', reason: 'PM checked the effort.', field_refs: {} });
  hoursProject.audit.push({ id: 'effort-edit', project_id: hoursProject.project.id, type: 'record_edited', actor: 'local manager', at: '2026-09-27T00:00:00.000Z', summary: 'PM corrected effort.', record_id: taskD.id, after: structuredClone(taskD) });
  hoursProject.deliverables[0].effort_hours = 999;
  const hoursResult = await runSimulation(hoursProject, fixedConfig(hoursProject, { c: 1, d: 2 }, 100));
  const hoursForecast = hoursResult.remainingWorkForecast!;
  assert.equal(hoursForecast.unit, 'hours');
  assert.deepEqual(hoursForecast.effortCoverage, { confirmedTaskCount: 2, totalTaskCount: 2 });
  assert.equal(hoursForecast.points[0].remaining.p50, 12);
  assert.deepEqual(hoursForecast.points.at(-1)!.remaining, { p10: 0, p50: 0, p90: 0 });

  hoursProject.audit = [];
  const incompleteEffortResult = await runSimulation(hoursProject, fixedConfig(hoursProject, { c: 1, d: 2 }, 100));
  assert.equal(incompleteEffortResult.remainingWorkForecast!.unit, 'tasks');
  assert.deepEqual(incompleteEffortResult.remainingWorkForecast!.effortCoverage, { confirmedTaskCount: 1, totalTaskCount: 2 });
});
