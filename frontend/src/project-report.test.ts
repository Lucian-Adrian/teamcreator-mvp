import assert from 'node:assert/strict';
import test from 'node:test';
import type { ProjectRecord, ProjectWorkspace } from '../../shared/types';
import type { SimulationOutput, SimulationResult } from '../../shared/simulation';
import { buildProjectReport } from './project-report';

function record(id: string, kind: ProjectRecord['kind'], title: string, status: string | null, reviewState: ProjectRecord['review_state'] = 'manager_confirmed'): ProjectRecord {
  return {
    id, kind, title, status, owner: null, due: null, depends_on: [], source_refs: [], evidence_state: 'supported', review_state: reviewState,
    created_at: '2026-09-27T00:00:00.000Z', updated_at: '2026-09-27T00:00:00.000Z',
  };
}

function workspace(): ProjectWorkspace {
  const delivered = record('delivered', 'deliverable', 'Plan livrat', 'done');
  delivered.completed_at = '2026-09-26';
  delivered.source_refs = [{ source_id: 'src', location: 'line 2', quote: 'Planul a fost livrat la 26 septembrie.' }];
  const next = record('next', 'deliverable', 'Pachet tehnic', 'planned');
  next.due = '2026-10-05';
  next.source_refs = [{ source_id: 'src', location: 'line 3', quote: 'Pachetul tehnic este planificat pentru 5 octombrie.' }];
  const approval = record('approval', 'task', 'Coordonează aprobarea beneficiarului', 'not_completed');
  approval.completed_at = '2026-09-25';
  approval.source_refs = [{ source_id: 'src', location: 'line 4', quote: 'Coordonează aprobarea beneficiarului.' }];
  const internal = record('internal', 'task', 'Planifică resursele echipei', 'in_progress');
  const proposed = record('proposed', 'deliverable', 'Livrabil neverificat', 'planned', 'unreviewed');
  return {
    project: { id: 'p', name: 'Proiect test', created_at: '2026-09-27T00:00:00.000Z', updated_at: '2026-09-27T00:00:00.000Z', synthetic: true },
    members: [], tasks: [approval, internal], deliverables: [delivered, next, proposed], risks: [], decisions: [],
    dependencies: [], assignments: [], sources: [{ id: 'src', name: 'plan.md', relative_path: 'plan.md', sha256: 'hash', size: 1, media_type: 'text/markdown', parser_status: 'parsed', created_at: '2026-09-27T00:00:00.000Z' }],
    proposals: [], changes: [], audit: [], graph: { cycles: [], has_cycles: false },
  };
}

function output(): SimulationOutput {
  const run = (kind: 'simulation_run', completionP50: number): SimulationResult => ({
    kind, projectId: 'p', modelVersion: '1.0.0', workspaceFingerprint: 'workspace', configFingerprint: '1234567890abcdef',
    seed: 4, iterations: 100, generatedAt: '2026-09-27T00:00:00.000Z',
    completionDays: { p10: completionP50 - 1, p50: completionP50, p80: completionP50 + 1, p90: completionP50 + 2 },
    completionDates: { p10: '2026-10-01', p50: '2026-10-02', p80: '2026-10-05', p90: '2026-10-06' },
    deadlineOutlook: null, histogram: [], families: [], stages: [], tasks: [], paths: [], metrics: {
      activeTaskCount: 3, dependencyCount: 2, crossOwnerHandoffCount: 1, assignmentCoverage: 0.5,
      maxParallelTasks: { p10: 1, p50: 1, p80: 2, p90: 2 }, capacityQueueDays: { p10: 0, p50: 1.5, p80: 2, p90: 3 },
    },
    missingness: { placeholderEstimateTaskIds: ['a'], unassignedTaskIds: [], placeholderCapacityMemberIds: ['m'], unresolvedDependencyTaskIds: [] },
    notes: [], config: {
      iterations: 100, seed: 4, estimates: {}, commonRisks: [], memberCapacity: {},
      calendar: { startDate: '2026-09-27', workingWeekdays: [1, 2, 3, 4, 5], holidays: [], deadlineDate: null },
    },
  });
  return run('simulation_run', 10) as unknown as SimulationOutput;
}

test('audience reports separate client facts from sponsor inferences and keep not_completed open', () => {
  const project = workspace();
  const client = buildProjectReport(output(), project, 'client');
  const deliveredSection = client.split('## Livrat și confirmat')[1].split('## Angajamente')[0];
  const upcomingSection = client.split('## Angajamente și livrabile următoare')[1].split('## Decizie necesară')[0];
  assert.match(deliveredSection, /Plan livrat/);
  assert.doesNotMatch(deliveredSection, /Coordonează aprobarea beneficiarului/);
  assert.match(upcomingSection, /Pachet tehnic/);
  assert.match(upcomingSection, /Coordonează aprobarea beneficiarului/);
  assert.match(client, /Sugestie, neconfirmată/);
  assert.doesNotMatch(client, /Planifică resursele|Livrabil neverificat|capacitate P50|Estimări placeholder/);
  assert.match(client, /plan\.md · line 4/);

  const sponsor = buildProjectReport(output(), project, 'sponsor');
  assert.match(sponsor, /Obiectiv[\s\S]*Necunoscut/);
  assert.match(sponsor, /Abatere față de plan[\s\S]*Necalculabilă/);
  assert.match(sponsor, /Inferență din simulare/);
  assert.match(sponsor, /Sugestie, neconfirmată/);

  const baseline = output() as SimulationResult;
  const comparison: SimulationOutput = {
    kind: 'simulation_comparison', projectId: 'p', modelVersion: '1.0.0', workspaceFingerprint: 'workspace',
    configFingerprint: 'comparison', generatedAt: '2026-09-27T00:00:00.000Z', sameRandomDraws: true,
    intervention: { kind: 'duration_shift', taskId: 'a', days: -1, label: 'Reducere testată pentru T-01' },
    baseline, scenario: { ...baseline, completionDays: { p10: 8, p50: 9, p80: 10, p90: 11 } },
    completionDeltaDays: { p10: -1, p50: -1, p80: -1, p90: -1 }, probabilityOfFasterFinish: 1,
  };
  const pairedSponsor = buildProjectReport(comparison, project, 'sponsor');
  assert.match(pairedSponsor, /Reducere testată pentru T-01/);
  assert.match(pairedSponsor, /aceleași extrageri aleatoare/);
});
