import type { ProjectProposal, ProposalItem, SourceRef } from './types.js';

/** True when approval wording supports a baseline date but not work status. */
export function approvalIsOnlyForBaseline(ref: SourceRef): boolean {
  const quote = ref.quote.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase();
  if (!/\bapproved\s+(?:project\s+)?baseline\b/.test(quote)) return false;
  return !/\b(?:status\s*(?:is|=)\s*approved|(?:is|was|has been|now|remains)\s+approved\b|approved\s+by\b)/.test(quote);
}

/** Quarantine a persisted model claim that maps baseline approval to work status. */
export function holdBaselineApprovalStatuses(proposal: ProjectProposal): ProposalItem[] {
  if (proposal.status !== 'proposed') return [];
  const held: ProposalItem[] = [];
  for (const item of proposal.items) {
    if (item.review_state === 'manager_confirmed' || item.conflict || item.fields.status?.toLocaleLowerCase() !== 'approved') continue;
    const refs = item.fields.field_refs?.status || item.source_refs;
    if (!refs.length || !refs.every(approvalIsOnlyForBaseline)) continue;
    delete item.fields.status;
    item.fields.evidence_state = 'conflict';
    item.conflict = true;
    item.review_state = 'unresolved';
    if (!proposal.conflicts.some((conflict) => conflict.field === 'status' && conflict.record_title === item.title)) {
      proposal.conflicts.push({
        field: 'status',
        record_title: item.title,
        claims: [
          { value: 'approved', source_refs: refs },
          { value: 'The quote approves a baseline date, not delivery status.', source_refs: refs },
        ],
      });
    }
    const note = `${item.title}: “approved baseline” supports a baseline date, not approved delivery status.`;
    if (!proposal.missing_info.includes(note)) proposal.missing_info.push(note);
    proposal.summary = 'Some proposed status claims need review. Baseline dates remain separate from delivery status.';
    held.push(item);
  }
  return held;
}
