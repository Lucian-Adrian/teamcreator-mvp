import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { ProjectProposal, ProjectSource, ProjectWorkspace, SourceRef } from '../shared/types.js';
import { holdBaselineApprovalStatuses } from '../shared/proposal-safety.js';
import { calculateImpact, findDependencyCycles } from './impact.js';
import { buildOwnerAssignments, buildProposal, labelPriorBatchDiagnostics, manualDependencySelection, mergeProposalIntoPending, newProjectRecord, normalizePendingProposalItems, normalizedKey, resolveDependencyPlaceholders, resolveOwnerPlaceholders } from './reconcile.js';
import { JsonStore } from './store.js';
import type { ExtractedRecord, ModelExtraction } from './provider.js';
import { checkinSourceName, parseSource } from './parser.js';

function emptyWorkspace(): ProjectWorkspace {
  const timestamp = '2026-09-26T00:00:00.000Z';
  return {
    project: { id: 'project-unseen-39', name: 'Harbor archive intake', created_at: timestamp, updated_at: timestamp, synthetic: false },
    members: [], tasks: [], deliverables: [], risks: [], decisions: [], dependencies: [], assignments: [], sources: [], proposals: [], changes: [], audit: [],
    graph: { cycles: [], has_cycles: false },
  };
}

const sources: ProjectSource[] = [
  { id: 'source-harbor-1', name: 'workplan.txt', sha256: 'a'.repeat(64), size: 200, media_type: 'text/plain', parser_status: 'parsed', created_at: '2026-09-26T00:00:00.000Z' },
  { id: 'source-harbor-2', name: 'change-log.txt', sha256: 'b'.repeat(64), size: 200, media_type: 'text/plain', parser_status: 'parsed', created_at: '2026-09-26T00:00:00.000Z' },
];

const textBySource = {
  'source-harbor-1': 'Budget signoff is due 2026-10-04.',
  'source-harbor-2': 'Budget signoff is due 2026-10-19. Task: Prepare archive index. The archive index is blocked until Budget signoff.',
};

function ref(sourceId: string, quote: string): SourceRef {
  return { source_id: sourceId, location: 'line 1', quote };
}

function extractedRecord(overrides: Partial<ExtractedRecord>): ExtractedRecord {
  return {
    kind: 'task', title: 'Budget signoff', description: null, role: null, member_type: null, status: null, owner: null, due: null,
    completed_at: null, due_basis: 'unknown', target_record_id: null, match_basis: 'new', depends_on_titles: [], source_refs: [], claims: [], ...overrides,
  };
}

test('keeps conflicting dates and unknown owners visible, and links only cited dependencies', () => {
  const firstDate = ref('source-harbor-1', 'Budget signoff is due 2026-10-04.');
  const secondDate = ref('source-harbor-2', 'Budget signoff is due 2026-10-19.');
  const dependencyQuote = 'The archive index is blocked until Budget signoff.';
  const dependency = ref('source-harbor-2', dependencyQuote);
  const extraction: ModelExtraction = {
    records: [
      extractedRecord({
        due: '2026-10-04', due_basis: 'reported', source_refs: [firstDate],
        claims: [{ field: 'due', value: '2026-10-04', source_refs: [firstDate] }],
      }),
      extractedRecord({
        due: '2026-10-19', due_basis: 'reported', source_refs: [secondDate],
        claims: [{ field: 'due', value: '2026-10-19', source_refs: [secondDate] }],
      }),
      extractedRecord({
        title: 'Prepare archive index', status: 'blocked', due_basis: 'unknown', depends_on_titles: ['Budget signoff'],
        source_refs: [dependency],
        claims: [
          { field: 'status', value: 'blocked', source_refs: [dependency] },
          { field: 'dependency', value: 'Budget signoff', source_refs: [dependency] },
        ],
      }),
    ],
    missing_info: [],
  };
  const proposal = buildProposal('project-unseen-39', emptyWorkspace(), sources, extraction, 'gpt-6-luna');
  const budget = proposal.items.find((item) => item.title === 'Budget signoff');
  const index = proposal.items.find((item) => item.title === 'Prepare archive index');
  assert.equal(proposal.conflicts.length, 1);
  assert.equal(proposal.conflicts[0].field, 'due');
  assert.equal(proposal.conflicts[0].claims.length, 2);
  assert.equal(budget?.fields.owner, null);
  assert.equal(budget?.fields.due, undefined);
  assert.equal(index?.fields.owner, null);
  assert.equal(index?.fields.unresolved_dependencies?.length, 0);
  assert.equal(index?.fields.depends_on?.length, 1);
  const edgeRefs = Object.values(index?.fields.dependency_refs || {}).flat();
  assert.deepEqual(edgeRefs, [dependency]);
  assert.equal(edgeRefs[0].quote, dependencyQuote);
});

test('matches check-in codes without duplicates, keeps completion separate, preserves absent fields, and links grounded owners', () => {
  const workspace = emptyWorkspace();
  const m14 = newProjectRecord({ kind: 'task', title: 'M-14, Approve survey package', owner: 'Iris Venn', due: '2026-10-01', due_basis: 'reported' });
  const p08 = newProjectRecord({ kind: 'task', title: 'P-08, Provision client gateway grant', owner: 'Asterion Client IT', due: '2026-10-10', due_basis: 'reported' });
  const oldStatusRef = { source_id: 'source-old-status', location: 'CSV row 4', quote: 'M-27 status: blocked.' };
  const m27 = newProjectRecord({ kind: 'task', title: 'M-27, Transfer image batches', owner: null, status: 'blocked', due: '2026-10-14', due_basis: 'reported', field_refs: { status: [oldStatusRef] } });
  const m38 = newProjectRecord({ kind: 'task', title: 'M-38, Validate searchable index', owner: null, due: null, due_basis: 'unknown' });
  const d04 = newProjectRecord({ kind: 'deliverable', title: 'D-04, Final archive handoff', owner: null, baseline_due: '2026-11-30', due_basis: 'baseline' });
  workspace.tasks.push(m14, p08, m27, m38);
  workspace.deliverables.push(d04);

  const source = { id: 'source-checkin-1', name: 'checkin.txt', sha256: 'c'.repeat(64), size: 600, media_type: 'text/plain', parser_status: 'parsed' as const, created_at: '2026-09-26T00:00:00.000Z' };
  const oldSource = { id: 'source-old-status', name: 'old-status.csv', sha256: 'd'.repeat(64), size: 80, media_type: 'text/csv', parser_status: 'parsed' as const, created_at: '2026-09-25T00:00:00.000Z' };
  const quoteM14 = 'M-14 is owned by Iris Venn.';
  const quoteP08 = 'P-08 is complete; Asterion Client IT owns the grant.';
  const quoteM27 = 'M-27 — Transfer image batches: Iris raportează că transferul loturilor de imagini s-a încheiat la 26.09.2026; termenul planificat rămâne 14.10.2026.';
  const quoteM38 = 'Dara Quill started M-38 — Validate searchable index.';
  const r14 = ref(source.id, quoteM14);
  const rP08 = ref(source.id, quoteP08);
  const rM27 = ref(source.id, quoteM27);
  const rM38 = ref(source.id, quoteM38);
  const extraction: ModelExtraction = {
    records: [
      extractedRecord({ title: 'M-14 Approve survey package', target_record_id: m14.id, match_basis: 'explicit_code', owner: 'Iris Venn', source_refs: [r14], claims: [{ field: 'owner', value: 'Iris Venn', source_refs: [r14] }] }),
      extractedRecord({ title: 'P-08 Provision client gateway grant', target_record_id: p08.id, match_basis: 'explicit_code', status: 'complete', owner: 'Asterion Client IT', source_refs: [rP08], claims: [{ field: 'status', value: 'complete', source_refs: [rP08] }, { field: 'owner', value: 'Asterion Client IT', source_refs: [rP08] }] }),
      extractedRecord({ title: 'M-27 Transfer image batches', target_record_id: m27.id, match_basis: 'explicit_code', status: 'blocked', completed_at: '2026-09-26', due: '2026-09-26', due_basis: 'unknown', source_refs: [oldStatusRef, rM27], claims: [{ field: 'status', value: 'blocked', source_refs: [oldStatusRef] }, { field: 'completed_at', value: '2026-09-26', source_refs: [rM27] }, { field: 'owner', value: null, source_refs: [rM27] }] }),
      extractedRecord({ title: 'M-38 Validate searchable index', target_record_id: m38.id, match_basis: 'explicit_code', status: 'in progress', owner: 'Dara Quill', source_refs: [rM38], claims: [{ field: 'status', value: 'in progress', source_refs: [rM38] }, { field: 'owner', value: 'Dara Quill', source_refs: [rM38] }] }),
      extractedRecord({ kind: 'member', title: 'Asterion Client IT', member_type: 'organization', match_basis: 'new', source_refs: [rP08], claims: [{ field: 'member_type', value: 'organization', source_refs: [rP08] }] }),
      extractedRecord({ kind: 'member', title: 'Dara Quill', member_type: 'person', match_basis: 'new', source_refs: [rM38], claims: [{ field: 'member_type', value: 'person', source_refs: [rM38] }] }),
      extractedRecord({ kind: 'member', title: 'Iris Venn', member_type: 'person', match_basis: 'new', source_refs: [r14], claims: [{ field: 'member_type', value: 'person', source_refs: [r14] }] }),
    ],
    missing_info: ['M-27 owner not stated.', 'D-04 owner not stated.'],
  };
  const proposal = buildProposal(workspace.project.id, workspace, [source, oldSource], extraction, 'gpt-6-luna');

  const codeUpdates = proposal.items.filter((item) => item.operation === 'update' && ['P-08', 'M-27', 'M-38'].some((code) => explicitTaskCode(item.title) === code));
  assert.equal(codeUpdates.length, 3, 'the three coded records update their existing rows');
  assert.equal(new Set(codeUpdates.map((item) => item.record_id)).size, 3);
  assert.equal(proposal.items.some((item) => item.operation === 'create' && ['P-08', 'M-27', 'M-38'].includes(explicitTaskCode(item.title))), false);

  const m27Update = codeUpdates.find((item) => explicitTaskCode(item.title) === 'M-27')!;
  assert.equal(m27Update.fields.completed_at, '2026-09-26');
  assert.equal(m27Update.fields.status, 'complete', 'a positively quoted Romanian completion statement resolves the old blocked status');
  assert.equal(m27Update.fields.field_refs?.status?.[0]?.quote, quoteM27, 'the derived status cites the new completion sentence, not the old tracker row');
  assert.equal(m27Update.fields.evidence_state, 'derived_by_rule');
  assert.equal('due' in m27Update.fields, false, 'a completion date does not replace planned due');
  assert.equal('baseline_due' in m27Update.fields, false, 'unmentioned baseline is preserved');
  assert.equal('owner' in m27Update.fields, false, 'an explicit missing owner does not clear or invent one');
  assert.equal(m27.owner, null);
  assert.equal(m27.due, '2026-10-14');
  assert.equal(d04.owner, null);
  assert.equal(d04.baseline_due, '2026-11-30');

  const explicitStatusRecord = extractedRecord({
    title: 'M-27 Transfer image batches', target_record_id: m27.id, match_basis: 'explicit_code', status: null,
    completed_at: '2026-09-26', source_refs: [oldStatusRef, rM27],
    claims: [
      { field: 'status', value: 'blocked', source_refs: [oldStatusRef] },
      { field: 'status', value: 'complete', source_refs: [rM27] },
      { field: 'completed_at', value: '2026-09-26', source_refs: [rM27] },
    ],
  });
  const explicitExtraction: ModelExtraction = {
    records: [...extraction.records.filter((record) => explicitTaskCode(record.title) !== 'M-27'), explicitStatusRecord],
    missing_info: [],
  };
  const explicitProposal = buildProposal(workspace.project.id, workspace, [source, oldSource], explicitExtraction, 'gpt-6-luna');
  const explicitM27 = explicitProposal.items.find((item) => item.record_id === m27.id)!;
  assert.equal(explicitM27.conflict, false, 'an accepted prior blocked claim does not conflict with a new completed claim');
  assert.equal(explicitM27.fields.status, 'complete');
  assert.deepEqual(explicitM27.fields.field_refs?.status, [rM27]);

  const p08Update = codeUpdates.find((item) => explicitTaskCode(item.title) === 'P-08')!;
  assert.equal(p08.owner, 'Asterion Client IT', 'an unchanged owner is preserved');
  assert.match(String(p08Update.fields.owner_id), /^candidate:member:/);
  const daraTaskUpdate = codeUpdates.find((item) => explicitTaskCode(item.title) === 'M-38')!;
  assert.equal(daraTaskUpdate.fields.owner, 'Dara Quill');
  assert.match(String(daraTaskUpdate.fields.owner_id), /^candidate:member:/);
  const ownerItems = proposal.items.filter((item) => item.operation === 'create' && item.record_kind === 'member');
  assert.equal(ownerItems.filter((item) => item.title === 'Iris Venn').length, 1);
  assert.equal(ownerItems.filter((item) => item.title === 'Dara Quill').length, 1);
  assert.equal(ownerItems.find((item) => item.title === 'Asterion Client IT')?.fields.member_type, 'organization');

  for (const item of proposal.items) {
    if (item.conflict) continue;
    if (item.operation === 'create') {
      const record = newProjectRecord({ ...item.fields, id: `accepted-${item.id}`, kind: item.record_kind, title: item.title });
      const target = item.record_kind === 'member' ? workspace.members : item.record_kind === 'task' ? workspace.tasks : workspace.deliverables;
      target.push(record);
      item.record_id = record.id;
    } else if (item.record_id) {
      const record = [...workspace.tasks, ...workspace.deliverables, ...workspace.members].find((entry) => entry.id === item.record_id);
      if (record) Object.assign(record, item.fields);
    }
  }
  resolveOwnerPlaceholders(workspace);
  const acceptedIris = workspace.members.find((member) => member.title === 'Iris Venn')!;
  const acceptedDara = workspace.members.find((member) => member.title === 'Dara Quill')!;
  const acceptedAsterion = workspace.members.find((member) => member.title === 'Asterion Client IT')!;
  assert.equal(m14.owner_id, acceptedIris.id);
  assert.equal(m38.owner_id, acceptedDara.id);
  assert.equal(p08.owner_id, acceptedAsterion.id);
  assert.equal(m27.owner_id, null);
  assert.equal(d04.owner_id, null);
  const assignmentLinks = buildOwnerAssignments(workspace);
  assert.equal(assignmentLinks.find((link) => link.record_id === m14.id)?.member_id, acceptedIris.id);
  assert.equal(assignmentLinks.find((link) => link.record_id === m38.id)?.member_id, acceptedDara.id);
  assert.equal(assignmentLinks.find((link) => link.record_id === p08.id)?.member_id, acceptedAsterion.id);
});

test('does not apply a completion date from a negated Romanian statement against a blocked task', () => {
  const workspace = emptyWorkspace();
  const blocked = newProjectRecord({ kind: 'task', title: 'M-27, Transfer image batches', status: 'blocked' });
  workspace.tasks.push(blocked);
  const source = { ...sources[0], id: 'source-negated-checkin', name: 'negated-checkin.txt' };
  const quote = 'M-27 — Transfer image batches: transferul loturilor nu s-a încheiat la 26.09.2026.';
  const evidence = ref(source.id, quote);
  const extraction: ModelExtraction = {
    records: [extractedRecord({
      title: 'M-27 Transfer image batches', target_record_id: blocked.id, match_basis: 'explicit_code', completed_at: '2026-09-26',
      source_refs: [evidence], claims: [{ field: 'completed_at', value: '2026-09-26', source_refs: [evidence] }],
    })],
    missing_info: [],
  };
  const proposal = buildProposal(workspace.project.id, workspace, [source], extraction, 'gpt-6-luna');
  const item = proposal.items.find((candidate) => candidate.record_id === blocked.id)!;
  assert.equal(item.conflict, true);
  assert.equal(item.review_state, 'unresolved');
  assert.equal(proposal.conflicts.some((conflict) => conflict.field === 'status' && conflict.claims.some((claim) => claim.source_refs.some((sourceRef) => sourceRef.quote === quote))), true);
  assert.equal(blocked.status, 'blocked');
});

test('normalizes explicitly unassigned owners without creating false member records', () => {
  const workspace = emptyWorkspace();
  const task = newProjectRecord({ kind: 'task', title: 'T-502, Confirm archive access', owner: 'Ivo Marin' });
  workspace.tasks.push(task);
  const source = { ...sources[0], id: 'source-unassigned-owner', name: 'check-in.md' };
  const quote = 'T-502 is currently unassigned.';
  const evidence = ref(source.id, quote);
  const extraction: ModelExtraction = {
    records: [
      extractedRecord({
        title: 'T-502 Confirm archive access', target_record_id: task.id, match_basis: 'explicit_code', owner: 'Unassigned',
        source_refs: [evidence], claims: [{ field: 'owner', value: 'Unassigned', source_refs: [evidence] }],
      }),
      extractedRecord({ kind: 'member', title: 'Unassigned', source_refs: [evidence] }),
    ],
    missing_info: [],
  };
  const proposal = buildProposal(workspace.project.id, workspace, [source], extraction, 'gpt-6-luna');
  const update = proposal.items.find((item) => item.record_id === task.id);
  assert.equal(update?.fields.owner, null);
  assert.notEqual(update?.fields.owner_id?.startsWith('candidate:member:'), true);
  assert.deepEqual(update?.fields.field_refs?.owner, [evidence]);
  assert.equal(proposal.items.some((item) => item.record_kind === 'member'), false);
  assert.ok(proposal.missing_info.some((item) => item.includes('Owner not stated for T-502')));

  const omittedOwner = buildProposal(workspace.project.id, workspace, [source], {
    records: [extractedRecord({ title: 'T-502 Confirm archive access', target_record_id: task.id, match_basis: 'explicit_code', owner: null })],
    missing_info: [],
  }, 'gpt-6-luna');
  assert.equal(omittedOwner.items.length, 0, 'an absent owner claim does not clear the current owner');
  assert.equal(task.owner, 'Ivo Marin');
});

test('merges later bounded extraction into a matching pending item and holds contradictory claims', () => {
  const workspace = emptyWorkspace();
  const firstSource = { ...sources[0], id: 'source-segment-one', name: 'schedule.md' };
  const nextSource = { ...sources[0], id: 'source-segment-two', name: 'minutes.md' };
  const conflictSource = { ...sources[0], id: 'source-segment-three', name: 'correction.md' };
  const firstQuote = 'T-20 Transfer files remains blocked.';
  const secondQuote = 'T-20 transfer batches are due 2026-10-12.';
  const conflictQuote = 'T-20 transfer batches are complete.';
  const firstRef = ref(firstSource.id, firstQuote);
  const secondRef = ref(nextSource.id, secondQuote);
  const conflictRef = ref(conflictSource.id, conflictQuote);
  const initial = buildProposal(workspace.project.id, workspace, [firstSource], {
    records: [extractedRecord({ title: 'T-20 Transfer files', status: 'blocked', source_refs: [firstRef], claims: [{ field: 'status', value: 'blocked', source_refs: [firstRef] }] })],
    missing_info: [],
  }, 'gpt-6-luna');
  workspace.proposals.push(initial);

  const next = buildProposal(workspace.project.id, workspace, [nextSource], {
    records: [extractedRecord({ title: 'T-20 Transfer batches', due: '2026-10-12', due_basis: 'reported', source_refs: [secondRef], claims: [{ field: 'due', value: '2026-10-12', source_refs: [secondRef] }] })],
    missing_info: [],
  }, 'gpt-6-luna');
  assert.equal(next.items[0].fields.due, '2026-10-12', 'the incoming segment has a cited due-date proposal');
  const merged = mergeProposalIntoPending(workspace, next);
  assert.equal(merged.id, initial.id);
  assert.equal(merged.items.length, 1, 'the same coded work item is not duplicated across segments');
  assert.deepEqual(merged.source_ids.sort(), [firstSource.id, nextSource.id].sort());
  assert.equal(merged.items[0].fields.status, 'blocked');
  assert.equal(merged.items[0].fields.due, '2026-10-12');

  const conflicting = buildProposal(workspace.project.id, workspace, [conflictSource], {
    records: [extractedRecord({ title: 'T-20 Transfer batches', status: 'complete', source_refs: [conflictRef], claims: [{ field: 'status', value: 'complete', source_refs: [conflictRef] }] })],
    missing_info: [],
  }, 'gpt-6-luna');
  mergeProposalIntoPending(workspace, conflicting);
  assert.equal(initial.items.length, 1);
  assert.equal(initial.items[0].fields.status, undefined, 'contradictory proposed status is held instead of selecting a winner');
  assert.equal(initial.items[0].conflict, true);
  assert.ok(initial.conflicts.some((item) => item.field === 'status'));
});

test('links a dependency to a pending draft and resolves it after a partial apply', () => {
  const workspace = emptyWorkspace();
  const sourceOne = { ...sources[0], id: 'source-t900-segment', name: 'archive-plan.md' };
  const sourceTwo = { ...sources[0], id: 'source-t901-segment', name: 'handover-note.md' };
  const t900Quote = 'T-900, Reconcile checksum ledger is blocked until source index validation.';
  const t901Quote = 'T-901, Verify package manifest depends on T-900, Reconcile checksum ledger.';
  const t900Ref = ref(sourceOne.id, t900Quote);
  const t901Ref = ref(sourceTwo.id, t901Quote);
  const initial = buildProposal(workspace.project.id, workspace, [sourceOne], {
    records: [extractedRecord({ title: 'T-900, Reconcile checksum ledger', status: 'blocked', source_refs: [t900Ref], claims: [{ field: 'status', value: 'blocked', source_refs: [t900Ref] }] })],
    missing_info: [],
  }, 'gpt-6-luna');
  workspace.proposals.push(initial);
  const pendingT900 = newProjectRecord({ ...initial.items[0].fields, id: `draft:${initial.items[0].id}`, kind: 'task', title: initial.items[0].title });
  const next = buildProposal(workspace.project.id, workspace, [sourceTwo], {
    records: [extractedRecord({
      title: 'T-901, Verify package manifest', depends_on_titles: ['T-900, Reconcile checksum ledger'], source_refs: [t901Ref],
      claims: [
        { field: 'dependency', value: 'T-900, Reconcile checksum ledger', source_refs: [t901Ref] },
      ],
    })],
    missing_info: [],
  }, 'gpt-6-luna', [pendingT900]);
  const merged = mergeProposalIntoPending(workspace, next);
  const handoverItem = merged.items.find((item) => item.title.startsWith('T-901'))!;
  const placeholder = `candidate:task:${normalizedKey('T-900, Reconcile checksum ledger')}`;
  assert.deepEqual(handoverItem.fields.depends_on, [placeholder]);
  assert.deepEqual(handoverItem.fields.dependency_refs?.[placeholder], [t901Ref]);

  const handover = newProjectRecord({ ...handoverItem.fields, kind: 'task', title: handoverItem.title });
  workspace.tasks.push(handover);
  handoverItem.record_id = handover.id;
  handoverItem.review_state = 'manager_confirmed';
  resolveDependencyPlaceholders(workspace);
  assert.deepEqual(handover.depends_on, []);
  assert.deepEqual(handover.unresolved_dependencies, ['T-900, Reconcile checksum ledger']);
  assert.ok(handover.dependency_refs?.[placeholder], 'citation is retained while the target draft is not accepted');

  const acceptedT900 = newProjectRecord({ kind: 'task', title: 'T-900, Reconcile checksum ledger' });
  workspace.tasks.push(acceptedT900);
  initial.items[0].record_id = acceptedT900.id;
  initial.items[0].review_state = 'manager_confirmed';
  resolveDependencyPlaceholders(workspace);
  assert.deepEqual(handover.depends_on, [acceptedT900.id]);
  assert.deepEqual(handover.unresolved_dependencies, []);
  assert.deepEqual(handover.dependency_refs?.[acceptedT900.id], [t901Ref]);
});

test('manual dependency mapping clears only the explicitly resolved unresolved label', () => {
  const blocker = newProjectRecord({ kind: 'task', title: 'Verify atlas index' });
  const task = newProjectRecord({ kind: 'task', title: 'Reconcile checksum ledger', unresolved_dependencies: ['T-900', 'T-901'] });
  const unchanged = manualDependencySelection(task, [blocker.id]);
  assert.deepEqual(unchanged.unresolved_dependencies, ['T-900', 'T-901'], 'a selected edge alone does not guess which label it resolves');

  const mapped = manualDependencySelection(task, [blocker.id], [{ label: 'T-900', dependency_id: blocker.id }]);
  assert.deepEqual(mapped.unresolved_dependencies, ['T-901']);
  assert.deepEqual(mapped.dependency_refs, { [blocker.id]: [] }, 'manager-added edges do not acquire unsupported source citations');
});

test('check-in labels without a supported extension are saved as text sources', () => {
  assert.equal(checkinSourceName('Daily check-in · 26 Sep 2026'), 'Daily check-in · 26 Sep 2026.txt');
  assert.equal(checkinSourceName('../voice notes'), 'voice notes.txt');
  assert.equal(checkinSourceName('weekly-update.md'), 'weekly-update.md');
});

test('resolves an owner link when a cited member is accepted after its task', () => {
  const workspace = emptyWorkspace();
  const evidence = ref('source-owner-later', 'Mira Solis owns the archive index.');
  const task = newProjectRecord({ kind: 'task', title: 'T-12, Build the archive index', owner: 'Mira Solis', owner_id: null, field_refs: { owner: [evidence] } });
  workspace.tasks.push(task);
  assert.deepEqual(resolveOwnerPlaceholders(workspace), []);
  const member = newProjectRecord({ kind: 'member', title: 'Mira Solis', member_type: 'person', source_refs: [evidence] });
  workspace.members.push(member);
  const linked = resolveOwnerPlaceholders(workspace);
  assert.equal(linked.length, 1);
  assert.equal(task.owner_id, member.id);
  assert.equal(buildOwnerAssignments(workspace).find((assignment) => assignment.record_id === task.id)?.member_id, member.id);
});

test('audited pending-item repair merges exact coded-title duplicates and canonicalizes linked dependency refs', () => {
  const workspace = emptyWorkspace();
  const sharedQuote = 'Reconcile checksum ledger remains blocked; due 2026-11-05.';
  const sharedRef = { source_id: 'source-t901-line333', location: 'line 333', quote: sharedQuote };
  const dependencyQuote = 'D-900, Deliver secure atlas handover, no owner stated, approved baseline date 2026-11-12; depends on T-901 Reconcile checksum ledger.';
  const dependencyRef = { source_id: 'source-d900-line505', location: 'line 505', quote: dependencyQuote };
  const oldPlaceholder = 'candidate:task:t-901 reconcile checksum ledger';
  const proposal: ProjectProposal = {
    id: 'proposal-long-context-review', project_id: workspace.project.id, title: 'Review held-out source updates', summary: 'Duplicate candidates need repair.',
    status: 'proposed', source_ids: [sharedRef.source_id, dependencyRef.source_id], created_at: '2026-09-26T12:00:00.000Z',
    conflicts: [], missing_info: [], provider_mode: 'model', provider_model: 'gpt-6-luna',
    items: [
      {
        id: 't901-item-old', operation: 'create', record_kind: 'task', record_id: null, title: 'Reconcile checksum ledger',
        fields: { kind: 'task', title: 'Reconcile checksum ledger', status: 'blocked', due: '2026-11-05', due_basis: 'reported', source_refs: [sharedRef], field_refs: { status: [sharedRef], due: [sharedRef] } },
        before: null, source_refs: [sharedRef], consequential: true, review_state: 'unreviewed', conflict: false,
      },
      {
        id: 't901-item-coded', operation: 'create', record_kind: 'task', record_id: null, title: 'T-901 Reconcile checksum ledger',
        fields: { kind: 'task', title: 'T-901 Reconcile checksum ledger', status: 'blocked', due: '2026-11-05', due_basis: 'reported', source_refs: [sharedRef], field_refs: { status: [sharedRef], due: [sharedRef] } },
        before: null, source_refs: [sharedRef], consequential: true, review_state: 'unreviewed', conflict: false,
      },
      {
        id: 'd900-item', operation: 'create', record_kind: 'deliverable', record_id: null, title: 'D-900, Deliver secure atlas handover',
        fields: { kind: 'deliverable', title: 'D-900, Deliver secure atlas handover', owner: null, baseline_due: '2026-11-12', due_basis: 'baseline', depends_on: [oldPlaceholder], dependency_refs: { [oldPlaceholder]: [dependencyRef] }, source_refs: [dependencyRef], field_refs: { baseline_due: [dependencyRef] } },
        before: null, source_refs: [dependencyRef], consequential: true, review_state: 'unreviewed', conflict: false,
      },
    ],
  };
  workspace.proposals.push(proposal);
  const repairs = normalizePendingProposalItems(workspace);
  assert.equal(repairs.length, 1);
  assert.equal(repairs[0].kept_item_id, 't901-item-old');
  assert.equal(repairs[0].merged_item_id, 't901-item-coded');
  assert.equal(proposal.items.length, 2);
  const t901 = proposal.items.find((item) => item.id === 't901-item-old')!;
  assert.equal(t901.fields.status, 'blocked');
  assert.equal(t901.fields.due, '2026-11-05');
  const d900 = proposal.items.find((item) => item.id === 'd900-item')!;
  const canonicalPlaceholder = 'candidate:task:reconcile checksum ledger';
  assert.deepEqual(d900.fields.depends_on, [canonicalPlaceholder]);
  assert.deepEqual(d900.fields.dependency_refs?.[canonicalPlaceholder], [dependencyRef]);
  assert.equal(d900.fields.baseline_due, '2026-11-12');
  assert.equal(d900.fields.owner, null);
});

test('holds approved-baseline evidence as a status conflict while retaining the baseline date', () => {
  const workspace = emptyWorkspace();
  const deliverable = newProjectRecord({ kind: 'deliverable', title: 'D-40, Catalogue handover', baseline_due: '2026-10-10', due_basis: 'baseline' });
  workspace.deliverables.push(deliverable);
  const source = { ...sources[0], id: 'source-d40-checkin', name: 'baseline-update.txt' };
  const quote = 'D-40 — Catalogue handover has an approved baseline 2026-10-10.';
  const evidence = ref(source.id, quote);
  const extraction: ModelExtraction = {
    records: [extractedRecord({
      kind: 'deliverable', title: 'D-40 Catalogue handover', target_record_id: deliverable.id, match_basis: 'explicit_code',
      status: 'approved', due: '2026-10-10', due_basis: 'baseline', source_refs: [evidence],
      claims: [
        { field: 'status', value: 'approved', source_refs: [evidence] },
        { field: 'due', value: '2026-10-10', source_refs: [evidence] },
      ],
    })],
    missing_info: [],
  };
  const proposal = buildProposal(workspace.project.id, workspace, [source], extraction, 'gpt-6-luna');
  const item = proposal.items.find((candidate) => candidate.record_id === deliverable.id)!;
  assert.equal(item.conflict, true);
  assert.equal(item.fields.status, undefined);
  assert.equal(item.fields.baseline_due, undefined, 'an already accepted baseline remains unchanged and is not restated as status');
  assert.equal(proposal.conflicts.some((conflict) => conflict.field === 'status' && conflict.record_title === 'D-40 Catalogue handover'), true);
  assert.equal(deliverable.baseline_due, '2026-10-10');
});

test('quarantines a persisted D-40-style proposal before selection without changing its baseline claim', () => {
  const evidence = { source_id: 'source-d40-checkin', location: 'line 4', quote: 'D-40 Catalogue handover, approved baseline 2026-10-10.' };
  const proposal: ProjectProposal = {
    id: 'proposal-d40-legacy', project_id: 'project-unseen-39', title: 'Review D-40', summary: '1 change proposed.', status: 'proposed',
    source_ids: [evidence.source_id],
    items: [{
      id: 'item-d40-legacy', operation: 'create', record_kind: 'deliverable', record_id: null, title: 'D-40 Catalogue handover',
      fields: { kind: 'deliverable', title: 'D-40 Catalogue handover', status: 'approved', due_basis: 'baseline', baseline_due: '2026-10-10', field_refs: { status: [evidence], baseline_due: [evidence] } },
      before: null, source_refs: [evidence], consequential: true, review_state: 'unreviewed', conflict: false,
    }],
    conflicts: [], missing_info: [], provider_mode: 'model', provider_model: 'gpt-6-luna', created_at: '2026-09-26T00:00:00.000Z',
  };
  const held = holdBaselineApprovalStatuses(proposal);
  assert.equal(held.length, 1);
  assert.equal(proposal.items[0].conflict, true);
  assert.equal(proposal.items[0].review_state, 'unresolved');
  assert.equal(proposal.items[0].fields.status, undefined);
  assert.equal(proposal.items[0].fields.baseline_due, '2026-10-10');
  assert.equal(proposal.conflicts[0].field, 'status');
  assert.equal(holdBaselineApprovalStatuses(proposal).length, 0, 'revalidation is idempotent');
});

test('labels old quote and dependency validation messages as batch history while preserving factual unknowns', () => {
  const proposal: ProjectProposal = {
    id: 'proposal-old-diagnostics', project_id: 'project-unseen-39', title: 'Review', summary: '2 changes proposed.', status: 'proposed',
    source_ids: ['source-harbor-2'],
    items: [{
      id: 'item-checksum', operation: 'create', record_kind: 'task', record_id: null, title: 'Reconcile checksum ledger',
      fields: { kind: 'task', title: 'Reconcile checksum ledger', dependency_refs: { 'candidate:task:archive-index': [ref('source-harbor-2', 'The ledger depends on the archive index.')] } },
      before: null, source_refs: [ref('source-harbor-2', 'The ledger depends on the archive index.')], consequential: false, review_state: 'unreviewed', conflict: false,
    }],
    conflicts: [], missing_info: [
      'Some candidate records were omitted because their quotes did not exactly match parsed source text.',
      'Could not verify or link dependency for Reconcile checksum ledger: Prepare archive index.',
      'Owner not stated for Reconcile checksum ledger.',
    ], provider_mode: 'model', provider_model: 'gpt-6-luna', created_at: '2026-09-26T00:00:00.000Z',
  };

  labelPriorBatchDiagnostics(proposal);
  assert.match(proposal.missing_info[0], /^Earlier extraction batch \(history; later segments may have changed this result\):/);
  assert.match(proposal.missing_info[1], /^Earlier extraction batch \(history; later segments may have changed this result\):/);
  assert.equal(proposal.missing_info[2], 'Owner not stated for Reconcile checksum ledger.');
  labelPriorBatchDiagnostics(proposal);
  assert.equal(proposal.missing_info[0].match(/Earlier extraction batch/g)?.length, 1, 'normalization is idempotent');
});

function explicitTaskCode(title: string) {
  return title.match(/\b([A-Z]{1,5}-\d+)\b/i)?.[1]?.toLocaleUpperCase() || '';
}

test('returns valid dependency impact paths beside an unrelated cycle', () => {
  const workspace = emptyWorkspace();
  const blocker = newProjectRecord({ kind: 'task', title: 'Survey gate', status: 'blocked', review_state: 'manager_confirmed' });
  const step = newProjectRecord({ kind: 'task', title: 'Delivery step', depends_on: [blocker.id], dependency_refs: { [blocker.id]: [ref('source-harbor-2', 'The archive index is blocked until Budget signoff.')] } });
  const handoff = newProjectRecord({ kind: 'deliverable', title: 'Client handoff', depends_on: [step.id], dependency_refs: { [step.id]: [ref('source-harbor-2', 'The archive index is blocked until Budget signoff.')] } });
  const cycleA = newProjectRecord({ kind: 'task', title: 'Cycle A' });
  const cycleB = newProjectRecord({ kind: 'task', title: 'Cycle B', depends_on: [cycleA.id] });
  cycleA.depends_on = [cycleB.id];
  workspace.tasks.push(blocker, step, cycleA, cycleB);
  workspace.deliverables.push(handoff);

  const cycles = findDependencyCycles(workspace);
  const impact = calculateImpact(workspace, blocker.id);
  assert.equal(cycles.length, 1);
  assert.equal(impact.graph.has_cycles, true);
  assert.equal(impact.paths.length, 2);
  assert.equal(impact.paths.some((path) => path.affected_id === handoff.id), true);
  assert.equal(impact.paths.every((path) => path.basis === 'derived_by_rule'), true);
  assert.match(impact.warning || '', /Cycle A|Cycle B/);
});

test('restores workspace and completed job metadata from local JSON after creating a new store instance', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'teamcreator-mvp-test-'));
  const root = path.resolve(os.tmpdir());
  const relative = path.relative(root, path.resolve(directory));
  assert.equal(relative.startsWith('..') || path.isAbsolute(relative), false);
  try {
    const first = new JsonStore(directory);
    const workspace = emptyWorkspace();
    workspace.tasks.push(newProjectRecord({ kind: 'task', title: 'Persisted intake', owner: null }));
    await first.transact((state) => { state.workspaces.push(workspace); });
    await first.saveJob({
      id: 'job-persist-39', project_id: workspace.project.id, kind: 'ingest', status: 'completed', phase: 'Complete',
      progress: 100, created_at: '2026-09-26T00:00:00.000Z', updated_at: '2026-09-26T00:00:01.000Z',
    });

    const reloaded = new JsonStore(directory);
    const restoredWorkspace = await reloaded.getWorkspace(workspace.project.id);
    const restoredJob = await reloaded.getJob('job-persist-39');
    assert.equal(restoredWorkspace?.tasks[0].title, 'Persisted intake');
    assert.equal(restoredWorkspace?.tasks[0].owner, null);
    assert.equal(restoredJob?.status, 'completed');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('stores full extracted text outside workspace JSON and keeps source text after store reload', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'teamcreator-mvp-sidecar-'));
  try {
    const first = new JsonStore(directory);
    const text = `${'Synthetic project evidence.\n'.repeat(4_000)}END_OF_FULL_TEXT`;
    await first.saveSourceText('source-sidecar-1', text);
    const statePath = path.join(directory, 'workspace.json');
    const persisted = await import('node:fs/promises').then(({ readFile }) => readFile(statePath, 'utf8'));
    assert.equal(persisted.includes('END_OF_FULL_TEXT'), false);

    const reloaded = new JsonStore(directory);
    assert.equal(await reloaded.getSourceText('source-sidecar-1'), text);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('parses long Markdown and CSV beyond old small per-source caps with honest coverage', async () => {
  const markdown = `Project archive notes\n${'handover record with evidence.\n'.repeat(1_500)}END_OF_LONG_TEXT`;
  const parsedMarkdown = await parseSource({ name: 'large.md', mediaType: 'text/markdown', bytes: Buffer.from(markdown) }, 'large-markdown');
  assert.equal(parsedMarkdown.status, 'parsed');
  assert.equal(parsedMarkdown.parseCoverage, 'complete');
  assert.ok(parsedMarkdown.text.length > 32_000);
  assert.ok(parsedMarkdown.text.includes('END_OF_LONG_TEXT'));

  const csv = ['task,owner', ...Array.from({ length: 650 }, (_, index) => `T-${index + 1},Person ${index + 1}`)].join('\n');
  const parsedCsv = await parseSource({ name: 'large.csv', mediaType: 'text/csv', bytes: Buffer.from(csv) }, 'large-csv');
  assert.equal(parsedCsv.status, 'parsed');
  assert.equal(parsedCsv.parseCoverage, 'complete');
  assert.ok(parsedCsv.text.includes('line 651'));
  assert.ok(parsedCsv.text.includes('T-650'));
});
