import { randomUUID } from 'node:crypto';
import type { MemberType, ProjectRecord, ProjectSource, ProjectWorkspace, ProjectProposal, ProposalItem, SourceConflict, SourceRef } from '../shared/types.js';
import type { ExtractedRecord, ModelExtraction } from './provider.js';
import { approvalIsOnlyForBaseline } from '../shared/proposal-safety.js';
import { isUnknownOwnerLabel } from '../shared/owners.js';

export function normalizedKey(value: string) {
  return value.normalize('NFKC').trim().toLocaleLowerCase().replace(/\s+/g, ' ');
}

function titleIdentityKey(value: string) {
  return normalizedKey(value).replace(/^[a-z]{1,5}-\d+\s*[,;:–—-]?\s*/, '').trim();
}

function sameTitleIdentity(left: string, right: string) {
  const leftCode = explicitCode(left);
  const rightCode = explicitCode(right);
  if (leftCode && rightCode) return leftCode === rightCode;
  return titleIdentityKey(left) === titleIdentityKey(right);
}

function distinctRefs(refs: SourceRef[]) {
  const seen = new Set<string>();
  return refs.filter((ref) => {
    const key = `${ref.source_id}\u0000${ref.location}\u0000${ref.quote}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

interface Candidate {
  kind: ExtractedRecord['kind'];
  title: string;
  description: string | null;
  role: string | null;
  member_type: MemberType | null;
  status: string | null;
  owner: string | null;
  due: string | null;
  completed_at: string | null;
  due_basis: ExtractedRecord['due_basis'];
  baseline_due: string | null;
  current_forecast: string | null;
  depends_on_titles: string[];
  source_refs: SourceRef[];
  field_refs: Record<string, SourceRef[]>;
  dependencyRefsByTitle: Record<string, SourceRef[]>;
  target_record_id: string | null;
  match_basis: ExtractedRecord['match_basis'];
  statusDerived?: boolean;
  conflicts: SourceConflict[];
}

type ClaimSet = Map<string, Map<string | null, SourceRef[]>>;

function normalizeProjectStatus(value: string) {
  const key = value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLocaleLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ');
  const known: Record<string, string> = {
    'in progress': 'in_progress', 'in lucru': 'in_progress',
    'not started': 'not_started', 'neinceput': 'not_started',
    'waiting for confirmation': 'waiting_for_confirmation', 'in asteptarea confirmarii': 'waiting_for_confirmation',
    'waiting': 'waiting', 'in asteptare': 'waiting',
    'blocked': 'blocked', 'blocat': 'blocked',
    'complete': 'complete', 'completed': 'complete', 'done': 'complete', 'finalizat': 'complete', 'finalizata': 'complete',
  };
  return known[key] || value;
}

function claimMapFor(records: ExtractedRecord[]): ClaimSet {
  const claims: ClaimSet = new Map();
  const add = (field: string, value: string | null, refs: SourceRef[]) => {
    if ((value === null && field !== 'owner') || !refs.length) return;
    const values = claims.get(field) || new Map<string, SourceRef[]>();
    const refsForValue = values.get(value) || [];
    values.set(value, distinctRefs([...refsForValue, ...refs]));
    claims.set(field, values);
  };
  for (const record of records) {
    const claimedFields = new Set<string>();
    for (const claim of record.claims || []) {
      let field: string = claim.field;
      if (field === 'due') {
        field = record.due_basis === 'baseline' ? 'baseline_due' : record.due_basis === 'forecast' ? 'current_forecast' : 'due';
      }
      if (field !== 'dependency') {
        claimedFields.add(field);
        const value = field === 'status' && claim.value ? normalizeProjectStatus(claim.value) : claim.value;
        add(field, value, claim.source_refs || []);
      }
    }
  }
  return claims;
}

function mergeCandidate(records: ExtractedRecord[]): Candidate {
  const first = records[0];
  const refs = distinctRefs(records.flatMap((record) => record.source_refs || []));
  const claimSet = claimMapFor(records);
  const conflicts: SourceConflict[] = [];
  const fieldRefs: Record<string, SourceRef[]> = {};
  const memberTypeString = (raw: string | null): MemberType | null => {
    return raw && ['person', 'organization', 'group', 'role', 'unknown'].includes(raw) ? raw as MemberType : null;
  };
  for (const [field, values] of claimSet.entries()) {
    fieldRefs[field] = distinctRefs([...values.values()].flat());
  }
  const describedRecord = records.find((record) => Boolean(record.description?.trim() && record.source_refs?.length));
  if (describedRecord && !fieldRefs.description?.length) fieldRefs.description = distinctRefs(describedRecord.source_refs);
  const valueFor = (field: string) => {
    const values = claimSet.get(field);
    if (!values?.size) return null;
    if (values.size > 1) {
      conflicts.push({
        field,
        record_title: first.title,
        claims: [...values.entries()].map(([value, source_refs]) => ({ value, source_refs })),
      });
      return null;
    }
    return values.keys().next().value as string | null;
  };

  const dependencyRefsByTitle: Record<string, SourceRef[]> = {};
  const dependencies = new Set<string>();
  for (const record of records) {
    for (const title of record.depends_on_titles || []) dependencies.add(title.trim());
    for (const claim of record.claims || []) {
      if (claim.field === 'dependency' && claim.value) dependencies.add(claim.value.trim());
    }
    for (const claim of record.claims || []) {
      if (claim.field === 'dependency' && claim.value) dependencyRefsByTitle[normalizedKey(claim.value)] = distinctRefs([
        ...(dependencyRefsByTitle[normalizedKey(claim.value)] || []), ...(claim.source_refs || []),
      ]);
    }
  }

  const due = valueFor('due');
  const baselineDue = valueFor('baseline_due');
  const forecast = valueFor('current_forecast');
  let status = valueFor('status');
  const statusRefs = fieldRefs.status || [];
  if (status?.toLocaleLowerCase() === 'approved' && statusRefs.length && statusRefs.every(approvalIsOnlyForBaseline)) {
    conflicts.push({
      field: 'status',
      record_title: first.title,
      claims: [
        { value: 'approved', source_refs: statusRefs },
        { value: 'The quote approves a baseline date, not delivery status.', source_refs: statusRefs },
      ],
    });
    status = null;
  }
  const dueBasis = due !== null ? 'reported' : baselineDue !== null ? 'baseline' : forecast !== null ? 'forecast' : first.due_basis;
  return {
    kind: first.kind,
    title: first.title.trim().slice(0, 180),
    description: claimSet.has('description') ? valueFor('description') : describedRecord?.description?.trim() || null,
    role: claimSet.has('role') ? valueFor('role') : null,
    member_type: memberTypeString(valueFor('member_type')),
    status,
    owner: valueFor('owner'),
    due: due ?? baselineDue ?? forecast,
    completed_at: valueFor('completed_at'),
    due_basis: dueBasis,
    baseline_due: baselineDue,
    current_forecast: forecast,
    depends_on_titles: [...dependencies].filter(Boolean),
    source_refs: refs,
    field_refs: fieldRefs,
    dependencyRefsByTitle,
    target_record_id: first.target_record_id || null,
    match_basis: first.match_basis,
    conflicts,
  };
}

function explicitCode(title: string) {
  return title.match(/\b([A-Z]{1,5}-\d+)\b/i)?.[1]?.toLocaleUpperCase() || null;
}

function completionAssertion(ref: SourceRef): 'positive' | 'negative' | 'unclear' {
  const normalized = ref.quote.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase();
  const positive = /\b(?:completed|complete|finished|done)\b|\b(?:s-a|s-au)\s+(?:incheiat|terminat|finalizat)\b|\b(?:este|e|sunt|a fost)\s+(?:gata|terminat|finalizat|incheiat)\b/gi;
  const matches = [...normalized.matchAll(positive)];
  if (!matches.length) return 'unclear';
  const negative = matches.some((match) => {
    const prefix = normalized.slice(0, match.index).split(/[.!?;]/).at(-1) || '';
    return /\b(?:not|never|nu|nici)\b/.test(prefix) && !/\bnot\s+only\b/.test(prefix);
  });
  return negative ? 'negative' : 'positive';
}

function novelRefs(field: string, candidate: Candidate, existing: ProjectRecord) {
  const accepted = new Set((existing.field_refs?.[field] || []).map((ref) => `${ref.source_id}\u0000${ref.location}\u0000${ref.quote}`));
  return (candidate.field_refs[field] || []).filter((ref) => !accepted.has(`${ref.source_id}\u0000${ref.location}\u0000${ref.quote}`));
}

function addCompletionConflict(candidate: Candidate, detail: string, refs: SourceRef[]) {
  const oldStatusRefs = candidate.field_refs.status || [];
  candidate.conflicts.push({
    field: 'status',
    record_title: candidate.title,
    claims: [
      ...(candidate.status ? [{ value: candidate.status, source_refs: oldStatusRefs }] : []),
      { value: detail, source_refs: refs },
    ],
  });
}

function candidateGroupKey(record: ExtractedRecord) {
  const code = explicitCode(record.title);
  return `${record.kind}:${code ? `code:${code}` : record.target_record_id ? `id:${record.target_record_id}` : `title:${normalizedKey(record.title)}`}`;
}

function memberPlaceholder(owner: string) {
  return `candidate:member:${normalizedKey(owner)}`;
}

function refsForClaim(record: ExtractedRecord, field: string) {
  return distinctRefs((record.claims || []).filter((claim) => claim.field === field && claim.value !== null).flatMap((claim) => claim.source_refs || []));
}

function candidatesWithOwnerMembers(extraction: ModelExtraction) {
  const records = extraction.records
    .filter((record) => !(record.kind === 'member' && isUnknownOwnerLabel(record.title)))
    .map((record) => ({
      ...record,
      owner: isUnknownOwnerLabel(record.owner) ? null : record.owner,
      claims: (record.claims || []).map((claim) => ({
        ...claim,
        ...(claim.field === 'owner' && isUnknownOwnerLabel(claim.value) ? { value: null } : {}),
      })),
    }));
  const ownerNames = new Map<string, { title: string; refs: SourceRef[] }>();
  for (const record of records) {
    if (!['task', 'deliverable'].includes(record.kind)) continue;
    for (const claim of record.claims || []) {
      if (claim.field !== 'owner' || !claim.value?.trim() || isUnknownOwnerLabel(claim.value) || !(claim.source_refs || []).length) continue;
      const key = normalizedKey(claim.value);
      const current = ownerNames.get(key) || { title: claim.value.trim(), refs: [] };
      current.refs = distinctRefs([...current.refs, ...claim.source_refs]);
      ownerNames.set(key, current);
    }
  }
  for (const owner of ownerNames.values()) {
    const existingMember = records.find((record) => record.kind === 'member' && normalizedKey(record.title) === normalizedKey(owner.title));
    if (existingMember) {
      existingMember.source_refs = distinctRefs([...existingMember.source_refs, ...owner.refs]);
      continue;
    }
    records.push({
      kind: 'member', title: owner.title, description: null, role: null, member_type: null,
      status: null, owner: null, due: null, completed_at: null, due_basis: 'unknown',
      target_record_id: null, match_basis: 'new', depends_on_titles: [], source_refs: owner.refs,
      claims: [],
    });
  }
  return records;
}

function fieldSnapshot(record: ProjectRecord) {
  return {
    id: record.id,
    kind: record.kind,
    title: record.title,
    status: record.status,
    owner: record.owner,
    due: record.due,
    due_basis: record.due_basis,
    baseline_due: record.baseline_due,
    current_forecast: record.current_forecast,
    depends_on: [...record.depends_on],
    source_refs: [...record.source_refs],
    evidence_state: record.evidence_state,
    review_state: record.review_state,
  };
}

function sameValue(left: unknown, right: unknown) {
  if (Array.isArray(left) || Array.isArray(right)) return JSON.stringify(left || []) === JSON.stringify(right || []);
  return left === right;
}

export function buildProposal(
  projectId: string,
  workspace: ProjectWorkspace,
  sources: ProjectSource[],
  extraction: ModelExtraction,
  providerModel: string,
  pendingDraftRecords: ProjectRecord[] = [],
): ProjectProposal {
  const extractionRecords = candidatesWithOwnerMembers(extraction);
  const grouped = new Map<string, ExtractedRecord[]>();
  for (const record of extractionRecords) {
    const key = candidateGroupKey(record);
    grouped.set(key, [...(grouped.get(key) || []), record]);
  }
  const candidates = [...grouped.values()].map(mergeCandidate);
  const proposalConflicts: SourceConflict[] = candidates.flatMap((candidate) => candidate.conflicts);
  const missing = [...extraction.missing_info];
  for (const candidate of candidates) {
    if (['task', 'deliverable'].includes(candidate.kind) && candidate.owner === null) {
      missing.push(`Owner not stated for ${candidate.title}.`);
    }
  }

  const items: ProposalItem[] = [];
  const existingList = [workspace.members, workspace.tasks, workspace.deliverables, workspace.risks, workspace.decisions].flat();
  const matchCandidate = (candidate: Candidate): { record?: ProjectRecord; conflict?: string } => {
    const code = explicitCode(candidate.title);
    const codeMatches = code ? existingList.filter((record) => record.kind === candidate.kind && explicitCode(record.title) === code) : [];
    const titleMatches = existingList.filter((record) => record.kind === candidate.kind && sameTitleIdentity(record.title, candidate.title));
    const target = candidate.target_record_id ? existingList.find((record) => record.id === candidate.target_record_id && record.kind === candidate.kind) : undefined;
    if (codeMatches.length > 1) return { conflict: `More than one current ${candidate.kind} uses code ${code}.` };
    if (codeMatches.length === 1) {
      if (target && target.id !== codeMatches[0].id) return { conflict: `The supplied record ID conflicts with explicit code ${code}.` };
      return { record: codeMatches[0] };
    }
    if (titleMatches.length > 1) return { conflict: 'More than one current record has this exact title.' };
    if (titleMatches.length === 1) {
      if (target && target.id !== titleMatches[0].id) return { conflict: 'The supplied record ID conflicts with the exact title.' };
      return { record: titleMatches[0] };
    }
    if (candidate.target_record_id) {
      if (!target) return { conflict: 'The proposed target record is not present in the current workspace.' };
      if (candidate.match_basis !== 'contextual' && candidate.match_basis !== 'explicit_code' && candidate.match_basis !== 'exact_title') {
        return { conflict: 'The source does not identify why this existing record is the intended target.' };
      }
      if (code && explicitCode(target.title) && explicitCode(target.title) !== code) return { conflict: `The target record conflicts with explicit code ${code}.` };
      return { record: target };
    }
    if (candidate.match_basis === 'unknown' || candidate.match_basis === 'contextual') {
      return { conflict: 'The source reference does not identify one existing record unambiguously. Clarification is needed before creating or updating a record.' };
    }
    return {};
  };
  const matchedByCandidate = new Map<Candidate, ProjectRecord | undefined>();
  const identityConflicts = new Map<Candidate, string>();
  for (const candidate of candidates) {
    const result = matchCandidate(candidate);
    matchedByCandidate.set(candidate, result.record);
    if (result.record) {
      const statusConflict = candidate.conflicts.find((conflict) => conflict.field === 'status');
      if (statusConflict) {
        const accepted = new Set((result.record.field_refs?.status || []).map((ref) => `${ref.source_id}\u0000${ref.location}\u0000${ref.quote}`));
        const novelClaims = statusConflict.claims.flatMap((claim) => {
          const refs = claim.source_refs.filter((ref) => !accepted.has(`${ref.source_id}\u0000${ref.location}\u0000${ref.quote}`));
          return claim.value !== null && refs.length ? [{ value: claim.value, refs }] : [];
        });
        const novelValues = [...new Set(novelClaims.map((claim) => claim.value))];
        if (novelValues.length === 1) {
          candidate.status = novelValues[0];
          candidate.field_refs.status = novelClaims.flatMap((claim) => claim.refs);
          candidate.conflicts = candidate.conflicts.filter((conflict) => conflict !== statusConflict);
          const priorConflictIndex = proposalConflicts.indexOf(statusConflict);
          if (priorConflictIndex >= 0) proposalConflicts.splice(priorConflictIndex, 1);
        }
      }
    }
    if (result.record && candidate.completed_at && candidate.field_refs.completed_at?.length) {
      const newCompletionRefs = novelRefs('completed_at', candidate, result.record);
      const newStatusRefs = novelRefs('status', candidate, result.record);
      const completionStates = newCompletionRefs.map(completionAssertion);
      const hasPositiveCompletion = completionStates.includes('positive');
      const hasNegativeCompletion = completionStates.includes('negative');
      const currentIsComplete = /^(?:complete|completed|done|finished)$/i.test(result.record.status || '');
      const proposedIsComplete = /^(?:complete|completed|done|finished)$/i.test(candidate.status || '');
      let completionConflict: SourceConflict | undefined;
      if (newCompletionRefs.length && hasNegativeCompletion) {
        addCompletionConflict(candidate, 'The quoted source negates completion; review the completion claim.', newCompletionRefs);
        completionConflict = candidate.conflicts.at(-1);
        missing.push(`${candidate.title}: the quoted completion date appears in a negated statement and needs review.`);
      } else if (newCompletionRefs.length && hasPositiveCompletion && !newStatusRefs.length && !currentIsComplete) {
        candidate.status = 'complete';
        candidate.statusDerived = true;
        candidate.field_refs.status = newCompletionRefs;
      } else if (newCompletionRefs.length && hasPositiveCompletion && newStatusRefs.length && !proposedIsComplete) {
        addCompletionConflict(candidate, 'The source asserts completion but also proposes a different status.', newCompletionRefs);
        completionConflict = candidate.conflicts.at(-1);
        missing.push(`${candidate.title}: completion and status claims need review.`);
      } else if (newCompletionRefs.length && !hasPositiveCompletion && !hasNegativeCompletion && !newStatusRefs.length && result.record.status && !currentIsComplete) {
        addCompletionConflict(candidate, 'A completion date is cited without an explicit positive completion statement.', newCompletionRefs);
        completionConflict = candidate.conflicts.at(-1);
        missing.push(`${candidate.title}: the completion date does not establish a completed status; confirm the current state.`);
      }
      if (completionConflict) proposalConflicts.push(completionConflict);
    }
    if (result.conflict) {
      identityConflicts.set(candidate, result.conflict);
      const refs = candidate.source_refs;
      proposalConflicts.push({ field: 'identity', record_title: candidate.title, claims: [{ value: result.conflict, source_refs: refs }] });
      missing.push(`${candidate.title}: ${result.conflict}`);
    }
  }

  const resolveDependency = (title: string) => {
    const code = explicitCode(title);
    const extracted = candidates.find((item) => ['task', 'deliverable'].includes(item.kind) && (
      sameTitleIdentity(item.title, title) || (code && explicitCode(item.title) === code)
    ));
    if (extracted) {
      const persisted = matchedByCandidate.get(extracted);
      if (persisted) return { id: persisted.id, kind: persisted.kind };
      if (identityConflicts.has(extracted)) return undefined;
      return { id: `candidate:${extracted.kind}:${normalizedKey(extracted.title)}`, kind: extracted.kind };
    }
    const persistedMatches = existingList.filter((item) => ['task', 'deliverable'].includes(item.kind) && (
      sameTitleIdentity(item.title, title) || (code && explicitCode(item.title) === code)
    ));
    if (persistedMatches.length === 1) return { id: persistedMatches[0].id, kind: persistedMatches[0].kind };
    if (persistedMatches.length > 1) return undefined;
    const pendingMatches = pendingDraftRecords.filter((item) => ['task', 'deliverable'].includes(item.kind) && (
      sameTitleIdentity(item.title, title) || (code && explicitCode(item.title) === code)
    ));
    if (pendingMatches.length !== 1) return undefined;
    return { id: `candidate:${pendingMatches[0].kind}:${normalizedKey(pendingMatches[0].title)}`, kind: pendingMatches[0].kind };
  };

  for (const candidate of candidates) {
    const existing = matchedByCandidate.get(candidate);
    const dependencies = candidate.depends_on_titles.map((title) => {
      if (!candidate.dependencyRefsByTitle[normalizedKey(title)]?.length) return undefined;
      return resolveDependency(title)?.id;
    }).filter((value): value is string => Boolean(value));
    const unresolved = candidate.depends_on_titles.filter((title) => {
      const target = resolveDependency(title);
      const hasEdgeEvidence = Boolean(candidate.dependencyRefsByTitle[normalizedKey(title)]?.length);
      return !target || !hasEdgeEvidence;
    });
    if (unresolved.length) missing.push(`Could not verify or link dependency for ${candidate.title}: ${unresolved.join(', ')}.`);
    const dependencyRefs: Record<string, SourceRef[]> = {};
    for (const depTitle of candidate.depends_on_titles) {
      const target = resolveDependency(depTitle);
      if (!target || !candidate.dependencyRefsByTitle[normalizedKey(depTitle)]?.length) continue;
      dependencyRefs[target.id] = candidate.dependencyRefsByTitle[normalizedKey(depTitle)];
    }

    const ownerName = candidate.owner;
    const ownerMember = ownerName
      ? workspace.members.find((member) => normalizedKey(member.title) === normalizedKey(ownerName))
      : undefined;
    const fields: Partial<ProjectRecord> = {
      kind: candidate.kind,
      title: candidate.title,
      description: candidate.description,
      role: candidate.role,
      member_type: candidate.member_type || (candidate.kind === 'member' ? 'unknown' : undefined),
      status: candidate.status,
      owner: candidate.owner,
      owner_id: candidate.owner ? ownerMember?.id || memberPlaceholder(candidate.owner) : null,
      due: candidate.due_basis === 'reported' || candidate.due_basis === 'unknown' ? candidate.due : null,
      due_basis: candidate.due_basis,
      baseline_due: candidate.baseline_due,
      current_forecast: candidate.current_forecast,
      completed_at: candidate.completed_at,
      depends_on: dependencies,
      dependency_refs: dependencyRefs,
      unresolved_dependencies: unresolved,
      source_refs: candidate.source_refs,
      field_refs: candidate.field_refs,
      evidence_state: candidate.conflicts.length ? 'conflict' : candidate.statusDerived ? 'derived_by_rule' : 'supported',
      review_state: candidate.conflicts.length ? 'unresolved' : 'unreviewed',
    };
    const safeFields: Partial<ProjectRecord> = { ...fields };
    for (const conflict of candidate.conflicts) delete (safeFields as Record<string, unknown>)[conflict.field];
    const isConflicted = candidate.conflicts.length > 0 || identityConflicts.has(candidate);
    if (!existing) {
      const unresolvedIdentity = identityConflicts.has(candidate);
      items.push({
        id: randomUUID(),
        operation: 'create',
        record_kind: candidate.kind,
        record_id: null,
        title: candidate.title,
        fields: safeFields,
        before: null,
        source_refs: candidate.source_refs,
        consequential: candidate.owner !== null || candidate.due !== null || candidate.completed_at !== null || candidate.status !== null || dependencies.length > 0,
        review_state: isConflicted ? 'unresolved' : 'unreviewed',
        conflict: isConflicted || unresolvedIdentity,
      });
      continue;
    }
    const nextFields: Partial<ProjectRecord> = {};
    const evidencedFields = new Set(Object.keys(candidate.field_refs));
    if (Object.keys(candidate.dependencyRefsByTitle).length) evidencedFields.add('depends_on');
    for (const field of ['status', 'owner', 'due', 'baseline_due', 'current_forecast', 'completed_at', 'depends_on', 'description', 'role', 'member_type']) {
      if (!evidencedFields.has(field) && !(field === 'depends_on' && candidate.depends_on_titles.length)) continue;
      const nextValue = (safeFields as Record<string, unknown>)[field];
      if (nextValue === undefined) continue;
      if (!sameValue((existing as unknown as Record<string, unknown>)[field], nextValue)) {
        (nextFields as Record<string, unknown>)[field] = nextValue;
      }
    }
    if (evidencedFields.has('owner')) {
      const nextOwnerId = candidate.owner ? ownerMember?.id || memberPlaceholder(candidate.owner) : null;
      if (existing.owner_id !== nextOwnerId) nextFields.owner_id = nextOwnerId;
    }
    const dateBasisClaimed = ['due', 'baseline_due', 'current_forecast'].some((field) => evidencedFields.has(field));
    if (dateBasisClaimed && evidencedFields.has('due') && existing.due_basis !== 'reported') nextFields.due_basis = 'reported';
    if (Object.keys(nextFields).length) {
      nextFields.field_refs = { ...(existing.field_refs || {}), ...candidate.field_refs };
      nextFields.source_refs = distinctRefs([...(existing.source_refs || []), ...candidate.source_refs]);
      nextFields.evidence_state = isConflicted ? 'conflict' : candidate.statusDerived ? 'derived_by_rule' : 'supported';
    }
    if (!Object.keys(nextFields).length) {
      if (isConflicted) items.push({
        id: randomUUID(),
        operation: 'update',
        record_kind: candidate.kind,
        record_id: existing.id,
        title: candidate.title,
        fields: {},
        before: {},
        source_refs: candidate.source_refs,
        consequential: false,
        review_state: 'unresolved',
        conflict: true,
      });
      continue;
    }
    items.push({
      id: randomUUID(),
      operation: 'update',
      record_kind: candidate.kind,
      record_id: existing.id,
      title: candidate.title,
      fields: nextFields,
      before: Object.fromEntries(Object.keys(nextFields).map((field) => [field, (existing as unknown as Record<string, unknown>)[field]])),
      source_refs: candidate.source_refs,
      consequential: ['owner', 'due', 'baseline_due', 'current_forecast', 'completed_at', 'status', 'depends_on'].some((key) => key in nextFields),
      review_state: isConflicted ? 'unresolved' : 'unreviewed',
      conflict: isConflicted,
    });
  }

  const conflictsForSources = new Set(proposalConflicts.flatMap((conflict) => conflict.claims.flatMap((claim) => claim.source_refs.map((ref) => ref.source_id))));
  for (const sourceId of conflictsForSources) {
    if (!sources.some((source) => source.id === sourceId)) throw new Error('A conflict points to an unknown source.');
  }
  return {
    id: randomUUID(),
    project_id: projectId,
    title: sources.length === 1 ? `Actualizări propuse din ${sources[0].name}` : `Actualizări propuse din ${sources.length} surse`,
    summary: items.length ? `${items.length} schimbări susținute de surse. Verifică citatele înainte de aprobare.` : 'Nu s-au extras schimbări. Verifică sursele și informațiile lipsă.',
    status: 'proposed',
    source_ids: sources.map((source) => source.id),
    items,
    conflicts: proposalConflicts,
    missing_info: [...new Set(missing)].slice(0, 100),
    provider_mode: 'model',
    provider_model: providerModel,
    created_at: new Date().toISOString(),
  };
}

function codeForTitle(title: string) {
  return explicitCode(title);
}

function refsForProposedField(item: ProposalItem, field: string) {
  return item.fields.field_refs?.[field] || item.source_refs;
}

function samePendingIdentity(left: ProposalItem, right: ProposalItem) {
  if (left.record_kind !== right.record_kind) return false;
  if (left.record_id || right.record_id) return left.record_id === right.record_id;
  return sameTitleIdentity(left.title, right.title);
}

function refsKey(ref: SourceRef) {
  return `${ref.source_id}\u0000${ref.location}\u0000${ref.quote}`;
}

function mergeRefs(left: SourceRef[], right: SourceRef[]) {
  const seen = new Set<string>();
  return [...left, ...right].filter((ref) => {
    const key = refsKey(ref);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function canonicalDependencyIdentity(dependencyId: string) {
  const match = dependencyId.match(/^candidate:(task|deliverable):(.+)$/);
  return match ? `candidate:${match[1]}:${titleIdentityKey(match[2])}` : dependencyId;
}

function mergeDependencyRefs(left: Record<string, SourceRef[]>, right: Record<string, SourceRef[]>) {
  const merged: Record<string, SourceRef[]> = {};
  for (const [dependencyId, refs] of Object.entries({ ...left, ...right })) {
    const key = canonicalDependencyIdentity(dependencyId);
    merged[key] = mergeRefs(merged[key] || [], [...(left[dependencyId] || []), ...(right[dependencyId] || [])]);
  }
  return merged;
}

/** Merge a new bounded extraction result into the latest pending review queue. */
export function mergeProposalIntoPending(workspace: ProjectWorkspace, incoming: ProjectProposal): ProjectProposal {
  const pending = workspace.proposals.find((proposal) => proposal.status === 'proposed');
  if (!pending) return incoming;
  pending.source_ids = [...new Set([...pending.source_ids, ...incoming.source_ids])];
  pending.missing_info = [...new Set([...pending.missing_info, ...incoming.missing_info])].slice(0, 100);
  for (const conflict of incoming.conflicts) {
    if (!pending.conflicts.some((item) => item.field === conflict.field && normalizedKey(item.record_title) === normalizedKey(conflict.record_title) && JSON.stringify(item.claims) === JSON.stringify(conflict.claims))) {
      pending.conflicts.push(conflict);
    }
  }

  for (const newItem of incoming.items) {
    const matches = pending.items.filter((item) => samePendingIdentity(item, newItem));
    if (matches.length !== 1) {
      if (matches.length > 1) {
        newItem.conflict = true;
        newItem.review_state = 'unresolved';
        newItem.fields = {};
        pending.conflicts.push({
          field: 'identity', record_title: newItem.title,
          claims: [{ value: 'More than one pending proposal item matches this extracted record.', source_refs: newItem.source_refs }],
        });
      }
      if (!pending.items.some((item) => item.id === newItem.id)) pending.items.push(newItem);
      continue;
    }

    const existing = matches[0];
    existing.source_refs = mergeRefs(existing.source_refs, newItem.source_refs);
    const oldFieldRefs = existing.fields.field_refs || {};
    const newFieldRefs = newItem.fields.field_refs || {};
    const combinedFieldRefs: Record<string, SourceRef[]> = { ...oldFieldRefs };
    for (const [field, refs] of Object.entries(newFieldRefs)) combinedFieldRefs[field] = mergeRefs(combinedFieldRefs[field] || [], refs);

    const factualFields = new Set([
      'owner', 'status', 'due', 'due_basis', 'baseline_due', 'current_forecast', 'completed_at',
      'depends_on', 'dependency_refs', 'unresolved_dependencies', 'description', 'role', 'member_type', 'owner_id',
    ]);
    const dependencyEvidence = Object.values(newItem.fields.dependency_refs || {}).some((refs) => refs.length > 0);
    const hasFieldEvidence = (field: string, refs: Record<string, SourceRef[]>) => {
      if (field === 'owner_id' || field === 'owner') return Boolean(refs.owner?.length);
      if (field === 'due_basis') return Boolean(refs.due?.length || refs.baseline_due?.length || refs.current_forecast?.length);
      return Boolean(refs[field]?.length);
    };
    const conflictingFields = new Set<string>();
    for (const [field, value] of Object.entries(newItem.fields)) {
      if (!factualFields.has(field)) continue;
      if (field === 'depends_on' && Array.isArray(value)) {
        const oldDependencies = Array.isArray(existing.fields.depends_on) ? existing.fields.depends_on : [];
        existing.fields.depends_on = [...new Set([...oldDependencies, ...value].map((item) => canonicalDependencyIdentity(String(item))))];
        continue;
      }
      if (field === 'dependency_refs' && value && typeof value === 'object') {
        existing.fields.dependency_refs = mergeDependencyRefs(
          existing.fields.dependency_refs || {},
          value as Record<string, SourceRef[]>,
        );
        continue;
      }
      if (field === 'owner_id' && conflictingFields.has('owner')) continue;
      if (field === 'due_basis' && ['due', 'baseline_due', 'current_forecast'].some((dateField) => conflictingFields.has(dateField))) continue;
      if (field === 'depends_on' && !dependencyEvidence) continue;
      if (field === 'dependency_refs' && !dependencyEvidence) continue;
      if (field !== 'depends_on' && field !== 'dependency_refs' && !hasFieldEvidence(field, newFieldRefs)) continue;
      const oldValue = hasFieldEvidence(field, oldFieldRefs) || (field === 'depends_on' && Object.values(existing.fields.dependency_refs || {}).some((refs) => refs.length))
        ? (existing.fields as Record<string, unknown>)[field]
        : undefined;
      if (oldValue === undefined) {
        (existing.fields as Record<string, unknown>)[field] = value;
        continue;
      }
      const equal = Array.isArray(oldValue) || Array.isArray(value)
        ? JSON.stringify(oldValue) === JSON.stringify(value)
        : oldValue === value;
      if (equal) continue;
      const previousRefs = oldFieldRefs[field] || existing.source_refs;
      const nextRefs = newFieldRefs[field] || newItem.source_refs;
      conflictingFields.add(field);
      existing.conflict = true;
      existing.review_state = 'unresolved';
      delete (existing.fields as Record<string, unknown>)[field];
      if (field === 'owner') delete (existing.fields as Record<string, unknown>).owner_id;
      delete combinedFieldRefs[field];
      pending.conflicts.push({
        field, record_title: existing.title,
        claims: [
          { value: oldValue === null ? null : JSON.stringify(oldValue), source_refs: previousRefs },
          { value: value === null ? null : JSON.stringify(value), source_refs: nextRefs },
        ],
      });
    }
    existing.fields.field_refs = combinedFieldRefs;
    existing.fields.source_refs = mergeRefs(existing.fields.source_refs || [], newItem.source_refs);
    existing.conflict = Boolean(existing.conflict || newItem.conflict);
    if (existing.conflict) existing.review_state = 'unresolved';
    existing.consequential ||= newItem.consequential;
  }

  pending.summary = `${pending.items.length} schimbări propuse din ${pending.source_ids.length} surse. Verifică citatele înainte de aprobare.`;
  return pending;
}

function itemsShareExactEvidence(left: ProposalItem, right: ProposalItem) {
  const refs = new Set(left.source_refs.map(refsKey));
  return right.source_refs.some((ref) => refs.has(refsKey(ref)));
}

function compatiblePendingDuplicate(left: ProposalItem, right: ProposalItem) {
  if (left.conflict || right.conflict || left.stale || right.stale) return false;
  if (left.review_state === 'manager_confirmed' || left.review_state === 'manager_corrected'
    || right.review_state === 'manager_confirmed' || right.review_state === 'manager_corrected') return false;
  if (!itemsShareExactEvidence(left, right)) return false;
  const leftRefs = left.fields.field_refs || {};
  const rightRefs = right.fields.field_refs || {};
  for (const field of ['owner', 'status', 'due', 'baseline_due', 'current_forecast', 'completed_at', 'member_type', 'role']) {
    const leftValue = (left.fields as Record<string, unknown>)[field];
    const rightValue = (right.fields as Record<string, unknown>)[field];
    if (leftValue === undefined || rightValue === undefined || sameValue(leftValue, rightValue)) continue;
    if (leftRefs[field]?.length && rightRefs[field]?.length) return false;
  }
  return true;
}

export interface PendingDuplicateRepair {
  proposal_id: string;
  kept_item_id: string;
  merged_item_id: string;
  title: string;
  before: ProposalItem;
  after: ProposalItem;
}

const EXTRACTION_BATCH_DIAGNOSTIC_PREFIX = 'Earlier extraction batch (history; later segments may have changed this result): ';

/** Keep failed-batch diagnostics visible without presenting them as current unresolved facts. */
export function labelPriorBatchDiagnostics(proposal: ProjectProposal) {
  const quoteValidationNote = 'Some candidate records were omitted because their quotes did not exactly match parsed source text.';
  proposal.missing_info = proposal.missing_info.map((note) => {
    const isQuoteValidationNote = note === quoteValidationNote;
    const isDependencyLinkNote = proposal.items.some((item) => note.startsWith(`Could not verify or link dependency for ${item.title}: `));
    if ((isQuoteValidationNote || isDependencyLinkNote) && !note.startsWith(EXTRACTION_BATCH_DIAGNOSTIC_PREFIX)) {
      return `${EXTRACTION_BATCH_DIAGNOSTIC_PREFIX}${note}`;
    }
    return note;
  });
}

/** Repair exact source-backed duplicate pending candidates and normalize their draft dependency aliases. */
export function normalizePendingProposalItems(workspace: ProjectWorkspace): PendingDuplicateRepair[] {
  const repairs: PendingDuplicateRepair[] = [];
  for (const proposal of workspace.proposals.filter((item) => item.status === 'proposed')) {
    for (let index = 0; index < proposal.items.length; index += 1) {
      const duplicate = proposal.items[index];
      const survivorIndex = proposal.items.findIndex((candidate, candidateIndex) => candidateIndex < index && samePendingIdentity(candidate, duplicate));
      if (survivorIndex < 0) continue;
      const survivor = proposal.items[survivorIndex];
      if (!compatiblePendingDuplicate(survivor, duplicate)) continue;
      const before = structuredClone(duplicate);
      const isolated = structuredClone(workspace);
      const isolatedProposal = isolated.proposals.find((candidate) => candidate.id === proposal.id);
      if (!isolatedProposal) continue;
      isolatedProposal.items = isolatedProposal.items.filter((candidate) => candidate.id !== duplicate.id);
      const incoming: ProjectProposal = {
        ...structuredClone(proposal),
        id: randomUUID(),
        source_ids: [...new Set(duplicate.source_refs.map((ref) => ref.source_id))],
        items: [structuredClone(duplicate)],
      };
      const merged = mergeProposalIntoPending(isolated, incoming);
      const mergedItem = merged.items.find((candidate) => candidate.id === survivor.id);
      if (!mergedItem) continue;
      proposal.items = merged.items;
      proposal.source_ids = merged.source_ids;
      proposal.missing_info = merged.missing_info;
      proposal.conflicts = merged.conflicts;
      proposal.summary = merged.summary;
      repairs.push({
        proposal_id: proposal.id,
        kept_item_id: survivor.id,
        merged_item_id: duplicate.id,
        title: survivor.title,
        before,
        after: structuredClone(mergedItem),
      });
      index -= 1;
    }

    const pendingRecords = proposal.items.filter((item) => ['task', 'deliverable'].includes(item.record_kind));
    const canonicalDraftKey = (raw: string) => {
      const match = raw.match(/^candidate:(task|deliverable):(.+)$/);
      if (!match) return raw;
      const targets = pendingRecords.filter((item) => item.record_kind === match[1] && sameTitleIdentity(item.title, match[2]));
      return targets.length === 1 ? `candidate:${match[1]}:${titleIdentityKey(targets[0].title)}` : raw;
    };
    for (const item of proposal.items) {
      if (Array.isArray(item.fields.depends_on)) {
        item.fields.depends_on = [...new Set(item.fields.depends_on.map((dependency) => canonicalDraftKey(String(dependency))))];
      }
      if (item.fields.dependency_refs) {
        const normalized: Record<string, SourceRef[]> = {};
        for (const [dependencyId, refs] of Object.entries(item.fields.dependency_refs)) {
          const key = canonicalDraftKey(dependencyId);
          normalized[key] = mergeRefs(normalized[key] || [], refs);
        }
        item.fields.dependency_refs = normalized;
      }
    }
  }
  return repairs;
}

export function newProjectRecord(fields: Partial<ProjectRecord>, now = new Date().toISOString()): ProjectRecord {
  const kind = fields.kind || 'task';
  return {
    id: fields.id || randomUUID(),
    kind,
    title: fields.title?.trim() || 'Untitled record',
    description: fields.description ?? null,
    role: fields.role ?? null,
    member_type: fields.member_type ?? (kind === 'member' ? 'unknown' : undefined),
    documented_skills: fields.documented_skills,
    availability_note: fields.availability_note ?? null,
    collaboration_profile: fields.collaboration_profile ?? null,
    planned_start: fields.planned_start ?? null,
    planned_duration_days: fields.planned_duration_days ?? null,
    effort_hours: fields.effort_hours ?? null,
    status: fields.status ?? null,
    owner: fields.owner ?? null,
    owner_id: fields.owner_id ?? null,
    due: fields.due ?? null,
    due_basis: fields.due_basis || 'unknown',
    completed_at: fields.completed_at ?? null,
    baseline_due: fields.baseline_due ?? null,
    current_forecast: fields.current_forecast ?? null,
    depends_on: fields.depends_on || [],
    dependency_refs: fields.dependency_refs || {},
    unresolved_dependencies: fields.unresolved_dependencies || [],
      source_refs: fields.source_refs || [],
      field_refs: fields.field_refs || {},
    evidence_state: fields.evidence_state || 'supported',
    review_state: fields.review_state || 'unreviewed',
    reason: fields.reason ?? null,
    created_at: fields.created_at || now,
    updated_at: fields.updated_at || now,
  };
}

export interface OwnerLinkResolution {
  record_id: string;
  title: string;
  owner: string | null;
  before_owner_id: string | null;
  after_owner_id: string | null;
  source_refs: SourceRef[];
}

export function resolveOwnerPlaceholders(workspace: ProjectWorkspace): OwnerLinkResolution[] {
  const changes: OwnerLinkResolution[] = [];
  for (const record of [...workspace.members, ...workspace.tasks, ...workspace.deliverables, ...workspace.risks, ...workspace.decisions]) {
    const placeholder = record.owner_id ?? null;
    const placeholderKey = placeholder?.startsWith('candidate:member:')
      ? placeholder.slice('candidate:member:'.length)
      : placeholder === null && record.owner
        ? normalizedKey(record.owner)
        : undefined;
    if (!placeholderKey) continue;
    const matches = workspace.members.filter((member) => normalizedKey(member.title) === placeholderKey);
    const nextOwnerId = matches.length === 1 ? matches[0].id : placeholder?.startsWith('candidate:member:') ? null : placeholder;
    if (nextOwnerId === placeholder) continue;
    record.owner_id = nextOwnerId;
    changes.push({
      record_id: record.id,
      title: record.title,
      owner: record.owner,
      before_owner_id: placeholder,
      after_owner_id: record.owner_id,
      source_refs: record.field_refs?.owner || [],
    });
  }
  return changes;
}

export function resolveDependencyPlaceholders(workspace: ProjectWorkspace) {
  const records = [workspace.members, workspace.tasks, workspace.deliverables, workspace.risks, workspace.decisions].flat();
  const recordsById = new Map(records.map((record) => [record.id, record]));
  const candidateIds = new Map<string, string | null>();
  const addCandidateAlias = (kind: string, title: string, recordId: string) => {
    const aliases = new Set([normalizedKey(title), titleIdentityKey(title)]);
    for (const alias of aliases) {
      const key = `candidate:${kind}:${alias}`;
      const existing = candidateIds.get(key);
      candidateIds.set(key, existing && existing !== recordId ? null : recordId);
    }
  };
  for (const record of records) addCandidateAlias(record.kind, record.title, record.id);
  const candidateTitles = new Map<string, string>();
  for (const proposal of workspace.proposals) {
    for (const item of proposal.items) {
      candidateTitles.set(`candidate:${item.record_kind}:${normalizedKey(item.title)}`, item.title);
      candidateTitles.set(`candidate:${item.record_kind}:${titleIdentityKey(item.title)}`, item.title);
    }
  }
  for (const record of records) {
    const oldRefs = record.dependency_refs || {};
    const oldDependencies = new Set(record.depends_on || []);
    const keys = new Set([...oldDependencies, ...Object.keys(oldRefs)]);
    const nextDependencies = new Set<string>();
    const nextRefs: Record<string, SourceRef[]> = {};
    const unresolved = new Set(record.unresolved_dependencies || []);
    for (const key of keys) {
      const canonicalKey = canonicalDependencyIdentity(key);
      const candidateTarget = candidateIds.get(canonicalKey);
      const resolvedId = typeof candidateTarget === 'string' ? candidateTarget : recordsById.has(key) ? key : undefined;
      const refs = oldRefs[key] || [];
      if (resolvedId && (oldDependencies.has(key) || refs.length)) {
        nextDependencies.add(resolvedId);
        if (refs.length) nextRefs[resolvedId] = mergeRefs(nextRefs[resolvedId] || [], refs);
        if (key.startsWith('candidate:')) {
          const title = candidateTitles.get(canonicalKey) || candidateTitles.get(key) || canonicalKey.slice(canonicalKey.lastIndexOf(':') + 1);
          for (const value of unresolved) if (normalizedKey(value) === normalizedKey(title)) unresolved.delete(value);
        }
        continue;
      }
      if (key.startsWith('candidate:')) {
        const title = candidateTitles.get(canonicalKey) || candidateTitles.get(key) || canonicalKey.slice(canonicalKey.lastIndexOf(':') + 1);
        unresolved.add(title);
        if (refs.length) nextRefs[key] = refs;
      } else if (oldDependencies.has(key)) {
        unresolved.add(key);
        if (refs.length) nextRefs[key] = refs;
      }
    }
    for (const title of [...unresolved]) {
      const code = explicitCode(title);
      const matches = records.filter((item) => ['task', 'deliverable'].includes(item.kind) && (
        sameTitleIdentity(item.title, title) || (code && explicitCode(item.title) === code)
      ));
      if (matches.length === 1) {
        nextDependencies.add(matches[0].id);
        unresolved.delete(title);
      }
    }
    record.depends_on = [...nextDependencies];
    record.dependency_refs = nextRefs;
    record.unresolved_dependencies = [...unresolved];
  }
}

export interface ManualDependencyResolution {
  label: string;
  dependency_id: string;
}

/** Apply manager-selected dependency edges and clear only labels explicitly mapped to those IDs. */
export function manualDependencySelection(
  record: ProjectRecord,
  selectedDependencyIds: string[],
  resolutions: ManualDependencyResolution[] = [],
): Pick<ProjectRecord, 'dependency_refs' | 'unresolved_dependencies'> {
  const existingDependencies = new Set(record.depends_on || []);
  const unresolved = [...(record.unresolved_dependencies || [])];
  const labelsToResolve = new Set(resolutions
    .filter((resolution) => selectedDependencyIds.includes(resolution.dependency_id))
    .map((resolution) => resolution.label));
  const dependencyRefs: Record<string, SourceRef[]> = {};
  for (const dependencyId of selectedDependencyIds) {
    dependencyRefs[dependencyId] = existingDependencies.has(dependencyId)
      ? (record.dependency_refs?.[dependencyId] || [])
      : [];
  }
  return { dependency_refs: dependencyRefs, unresolved_dependencies: unresolved.filter((label) => !labelsToResolve.has(label)) };
}

export function buildOwnerAssignments(workspace: ProjectWorkspace) {
  const membersById = new Map(workspace.members.map((member) => [member.id, member]));
  const records = [workspace.members, workspace.tasks, workspace.deliverables, workspace.risks, workspace.decisions].flat();
  return records.flatMap((record) => {
    const member = record.owner_id ? membersById.get(record.owner_id) : undefined;
    return member ? [{
      id: `${record.id}:${member.id}`,
      record_id: record.id,
      member_id: member.id,
      evidence_state: record.field_refs?.owner?.length ? 'supported' as const : 'derived_by_rule' as const,
      source_refs: record.field_refs?.owner || [],
    }] : [];
  });
}
