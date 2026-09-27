import React, { useEffect, useMemo, useState } from 'react';
import { AlertCircle, ArrowRight, ArrowUpRight, Check, CheckCheck, Clock3, FileText, History, Info, Plus, ShieldCheck, X } from 'lucide-react';
import type { ProjectProposal, ProjectRecord, ProjectSource, ProjectWorkspace, SourceRef } from '../../shared/types';
import { isPresentationDemo } from '../../shared/presentation-demo';
import IntegrationPanel from './IntegrationPanel';
import type { IntegrationId, IntegrationStatus } from './IntegrationPanel';
import './context-workspace.css';

export type ContextTab = 'sources' | 'review' | 'history';

export interface ContextWorkspaceProps {
  workspace: ProjectWorkspace;
  tab: ContextTab;
  onTabChange: (tab: ContextTab) => void;
  onAddSources: () => void;
  onOpenSource: (ref: SourceRef) => void;
  onOpenRecord: (kind: 'member' | 'task' | 'deliverable', id: string) => void;
  onRetry: (sourceIds?: string[], options?: { reprocess?: boolean }) => void | Promise<void>;
  retrying: boolean;
  retryResult: string;
  onDecide: (proposal: ProjectProposal, decision: 'apply' | 'reject', itemIds?: string[]) => void | Promise<void>;
  onReviewItem: (proposal: ProjectProposal, itemId: string, action: 'reject' | 'correct', reason: string, fields?: Record<string, unknown>) => void | Promise<void>;
  proposalBusyId: string;
  provider?: Record<string, unknown> | null;
  connections?: Partial<Record<IntegrationId, IntegrationStatus>>;
  storageMode?: 'browser' | 'server';
  focusSourceId?: string;
  focusRef?: SourceRef | null;
  onClearFocus?: () => void;
  onOpenMap?: () => void;
  toolbarContent?: React.ReactNode;
  reviewContent?: React.ReactNode;
  historyContent?: React.ReactNode;
}

type PhaseState = 'complete' | 'partial' | 'waiting' | 'unavailable' | 'empty';
type SourceFact = { proposal: ProjectProposal; item: ProjectProposal['items'][number] };
type SourceRecordFact = { record: ProjectRecord; ref: SourceRef };

const kindLabels: Record<string, string> = { member: 'Persoană / rol', task: 'Sarcină', deliverable: 'Livrabil', risk: 'Risc', decision: 'Decizie' };
const tabLabels: Array<{ id: ContextTab; label: string }> = [
  { id: 'sources', label: 'Surse' }, { id: 'review', label: 'De verificat' }, { id: 'history', label: 'Istoric' },
];

function allRecords(workspace: ProjectWorkspace): ProjectRecord[] {
  return [...workspace.members, ...workspace.tasks, ...workspace.deliverables, ...workspace.risks, ...workspace.decisions];
}

function formatBytes(bytes: number): string {
  if (!bytes) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function sourceType(source: ProjectSource): string {
  const extension = source.name.split('.').pop()?.toUpperCase();
  return extension && extension !== source.name.toUpperCase() ? extension : source.media_type || 'Fișier';
}

function pendingSourceFacts(workspace: ProjectWorkspace, sourceId: string): SourceFact[] {
  return workspace.proposals.filter((proposal) => proposal.status === 'proposed').flatMap((proposal) => proposal.items
    .filter((item) => item.review_state !== 'manager_confirmed' && item.source_refs.some((ref) => ref.source_id === sourceId))
    .map((item) => ({ proposal, item })));
}

function proposalSourceFacts(workspace: ProjectWorkspace, sourceId: string): SourceFact[] {
  return workspace.proposals.flatMap((proposal) => proposal.items
    .filter((item) => item.source_refs.some((ref) => ref.source_id === sourceId))
    .map((item) => ({ proposal, item })));
}

function acceptedSourceFacts(workspace: ProjectWorkspace, sourceId: string): SourceRecordFact[] {
  return allRecords(workspace).flatMap((record) => record.source_refs
    .filter((ref) => ref.source_id === sourceId)
    .map((ref) => ({ record, ref })));
}

function preferredSourceId(workspace: ProjectWorkspace): string {
  let preferredId = '';
  let highestPendingCount = 0;
  for (const source of workspace.sources) {
    const count = pendingSourceFacts(workspace, source.id).length;
    if (count > highestPendingCount) { preferredId = source.id; highestPendingCount = count; }
  }
  return preferredId || workspace.sources[0]?.id || '';
}

function sourceLifecycle(workspace: ProjectWorkspace, source: ProjectSource) {
  const proposalFacts = proposalSourceFacts(workspace, source.id);
  const pending = pendingSourceFacts(workspace, source.id);
  const records = acceptedSourceFacts(workspace, source.id);
  const hasFacts = proposalFacts.length > 0 || records.length > 0;
  const extraction: PhaseState = source.extraction_coverage === 'complete'
    ? 'complete'
    : source.extraction_coverage === 'partial' || hasFacts
      ? 'partial'
      : source.extraction_coverage === 'unavailable'
        ? 'unavailable'
        : 'waiting';
  const reviewedRecords = records.every(({ record }) => record.review_state === 'manager_confirmed' || record.review_state === 'manager_corrected');
  const reviewedProposals = proposalFacts.every(({ proposal, item }) => proposal.status !== 'proposed' || item.review_state === 'manager_confirmed');
  const review: PhaseState = !hasFacts
    ? 'empty'
    : pending.length || !reviewedRecords || !reviewedProposals
      ? 'partial'
      : 'complete';
  return {
    loaded: 'complete' as PhaseState,
    parsed: source.parser_status === 'parsed' ? 'complete' as PhaseState : source.parser_status === 'empty' ? 'empty' as PhaseState : 'unavailable' as PhaseState,
    extraction,
    review,
    pendingCount: pending.length,
    extractedCount: proposalFacts.length + records.length,
    hasFacts,
  };
}

function phaseText(phase: string, state: PhaseState, source: ProjectSource, lifecycle: ReturnType<typeof sourceLifecycle>): string {
  const descriptions: Record<string, Record<PhaseState, string>> = {
    loaded: { complete: 'Sursa este păstrată în proiect.', partial: '', waiting: '', unavailable: '', empty: '' },
    parsed: { complete: 'Textul a fost citit de parser.', partial: 'Parserul nu a terminat sau a raportat conținut gol.', waiting: 'Așteaptă citirea fișierului.', unavailable: 'Formatul nu este suportat în acest mediu.', empty: 'Nu a fost extras text.' },
    extraction: {
      complete: 'Extragerea raportată s-a încheiat.', partial: lifecycle.pendingCount ? `${lifecycle.pendingCount} ${lifecycle.pendingCount === 1 ? 'afirmație așteaptă' : 'afirmații așteaptă'} verificarea.` : 'Există afirmații, dar acoperirea completă nu este raportată.',
      waiting: 'Nu există o confirmare că extragerea a rulat.', unavailable: source.extraction_note || 'Extragerea nu este disponibilă.', empty: 'Nu au fost găsite afirmații cu sursă.',
    },
    review: {
      complete: 'Afirmațiile asociate au fost acceptate sau respinse.', partial: lifecycle.pendingCount === 1 ? '1 afirmație nu a fost încă verificată.' : lifecycle.pendingCount ? `${lifecycle.pendingCount} afirmații nu au fost încă verificate.` : 'Unele afirmații nu au fost încă verificate.',
      waiting: 'Încă nu există afirmații de verificat.', unavailable: 'Extragerea nu este disponibilă.', empty: 'Nicio afirmație extrasă pentru verificare.',
    },
  };
  return descriptions[phase]?.[state] || '';
}

function PhaseMark({ label, phase, state, source, lifecycle }: { label: string; phase: string; state: PhaseState; source: ProjectSource; lifecycle: ReturnType<typeof sourceLifecycle> }) {
  const title = phaseText(phase, state, source, lifecycle);
  const icon = state === 'complete' ? <Check size={13} /> : state === 'partial' ? <AlertCircle size={13} /> : state === 'unavailable' ? <X size={13} /> : state === 'empty' ? <Info size={13} /> : <Clock3 size={13} />;
  const stateLabel = phase === 'review'
    ? state === 'complete' ? 'Verificat' : state === 'partial' ? 'De verificat' : state === 'empty' ? 'N/A' : state === 'unavailable' ? 'Indisponibil' : 'Așteaptă'
    : state === 'complete' ? 'Da' : state === 'empty' ? 'N/A' : state === 'partial' ? 'Parțial' : state === 'unavailable' ? 'Nu' : 'Așteaptă';
  return <span className={`ctx-phase ctx-phase-${state}`} title={title} aria-label={`${label}: ${title}`}><span>{icon}</span><small>{stateLabel}</small></span>;
}

function extractionNote(source: ProjectSource) {
  if (source.fixture_only) return 'Sursă sintetică de demonstrație, cu afirmații și citate pregătite pentru verificare.';
  const note = source.extraction_note || '';
  const match = note.match(/^No model ran\. Deterministic browser rules mapped (\d+) structured rows? into pending cited proposals\.$/);
  return match ? `Regulile de import au pregătit ${match[1]} propuneri din tabel. Nu a rulat un model AI.` : note;
}

function FieldRow({ label, value, before }: { label: string; value: unknown; before?: unknown }) {
  if (value === undefined || value === null || value === '') return null;
  const statuses: Record<string, string> = { not_started: 'De început', in_progress: 'În lucru', blocked: 'Blocat', complete: 'Finalizat', completed: 'Finalizat', waiting_for_confirmation: 'Așteaptă confirmarea', waiting: 'În așteptare', accepted: 'Acceptat' };
  const format = (item: unknown) => Array.isArray(item) ? item.join(', ') : label === 'Stare' ? statuses[String(item)] || String(item) : String(item);
  const display = format(value);
  const previous = before === undefined || before === null || before === '' ? '' : format(before);
  return <div className="ctx-field-row"><span>{label}</span><div><strong>{display}</strong>{previous && previous !== display && <small>Înainte: {previous}</small>}</div></div>;
}

function FactReviewCard({ fact, source, busy, onDecide, onReviewItem, onOpenSource }: {
  fact: SourceFact; source: ProjectSource; busy: boolean;
  onDecide: ContextWorkspaceProps['onDecide']; onReviewItem: ContextWorkspaceProps['onReviewItem']; onOpenSource: (ref: SourceRef) => void;
}) {
  const { proposal, item } = fact;
  const [mode, setMode] = useState<'correct' | 'reject' | null>(null);
  const [reason, setReason] = useState('');
  const [actionError, setActionError] = useState('');
  const initial = useMemo(() => ({
    title: String(item.fields.title || item.title || ''), owner: String(item.fields.owner || ''),
    status: String(item.fields.status || ''), due: String(item.fields.due || '').slice(0, 10),
    description: String(item.fields.description || ''),
  }), [item.id, item.fields, item.title]);
  const [draft, setDraft] = useState(initial);
  useEffect(() => { setDraft(initial); setMode(null); setReason(''); setActionError(''); }, [item.id, initial]);
  const update = (key: keyof typeof initial, value: string) => setDraft((current) => ({ ...current, [key]: value }));
  const isHeld = Boolean(item.conflict || item.stale || item.review_state === 'unresolved');
  const isBusy = busy || (item.review_state === 'manager_confirmed');
  const refs = item.source_refs.filter((ref) => ref.source_id === source.id);
  const handleAccept = async () => {
    setActionError('');
    try { await onDecide(proposal, 'apply', [item.id]); }
    catch (error) { setActionError(error instanceof Error ? error.message : 'Nu am putut accepta afirmația.'); }
  };
  const handleReject = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!reason.trim()) return;
    setActionError('');
    try { await onReviewItem(proposal, item.id, 'reject', reason.trim()); setMode(null); }
    catch (error) { setActionError(error instanceof Error ? error.message : 'Nu am putut respinge afirmația.'); }
  };
  const handleCorrection = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!reason.trim()) return;
    const changed: Record<string, unknown> = {};
    for (const key of Object.keys(initial) as Array<keyof typeof initial>) {
      if (draft[key] === initial[key]) continue;
      const nullable = key !== 'title';
      changed[key] = nullable && !draft[key].trim() ? null : draft[key].trim();
    }
    if (!Object.keys(changed).length) { setActionError('Modifică cel puțin un câmp și explică motivul.'); return; }
    setActionError('');
    try { await onReviewItem(proposal, item.id, 'correct', reason.trim(), changed); setMode(null); }
    catch (error) { setActionError(error instanceof Error ? error.message : 'Nu am putut salva corectarea.'); }
  };

  return <article className="ctx-fact-card">
    <div className="ctx-fact-kicker"><span>{kindLabels[item.record_kind] || item.record_kind}</span><span>{item.operation === 'update' ? 'Modificare propusă' : 'Afirmație nouă'}</span></div>
    <h3>{item.title}</h3>
    {item.fields.description && <p className="ctx-fact-description">{String(item.fields.description).replace(/^Dependency as written in source: /, 'Dependență consemnată în sursă: ')}</p>}
    <div className="ctx-fact-fields">
      <FieldRow label="Responsabil" value={item.fields.owner} before={item.before?.owner} />
      <FieldRow label="Termen" value={item.fields.due} before={item.before?.due} />
      <FieldRow label="Stare" value={item.fields.status} before={item.before?.status} />
      <FieldRow label="Rol" value={item.fields.role} before={item.before?.role} />
      <FieldRow label="Competențe consemnate" value={item.fields.documented_skills} before={item.before?.documented_skills} />
      <FieldRow label="Disponibilitate declarată" value={item.fields.availability_note} before={item.before?.availability_note} />
      <FieldRow label="Start planificat" value={item.fields.planned_start} before={item.before?.planned_start} />
      <FieldRow label="Durată planificată" value={item.fields.planned_duration_days == null ? undefined : `${item.fields.planned_duration_days} zile`} before={item.before?.planned_duration_days == null ? undefined : `${item.before.planned_duration_days} zile`} />
      <FieldRow label="Efort estimat" value={item.fields.effort_hours == null ? undefined : `${item.fields.effort_hours} ore`} before={item.before?.effort_hours == null ? undefined : `${item.before.effort_hours} ore`} />
    </div>
    {refs.map((ref, index) => <div className="ctx-source-quote" key={`${ref.location}-${index}`}><div><FileText size={14} /><strong>{source.name}</strong><span>{ref.location || 'Locație neînregistrată'}</span><button type="button" onClick={() => onOpenSource(ref)}>Deschide sursa <ArrowUpRight size={12} /></button></div><blockquote>„{ref.quote}”</blockquote></div>)}
    {item.fields.collaboration_profile && <div className="ctx-profile-note"><ShieldCheck size={14} /><span><strong>{item.fields.collaboration_profile.basis === 'declared' ? 'Profil de colaborare declarat' : 'Evaluare de colaborare furnizată'}</strong><small>{item.fields.collaboration_profile.source_label}{item.fields.collaboration_profile.recorded_on ? ` · ${item.fields.collaboration_profile.recorded_on}` : ''}</small>{item.fields.collaboration_profile.soft_skills.length > 0 && <small>Competențe relaționale consemnate: {item.fields.collaboration_profile.soft_skills.join(', ')}</small>}{item.fields.collaboration_profile.working_preferences && <small>Preferințe de lucru: {item.fields.collaboration_profile.working_preferences}</small>}{item.fields.collaboration_profile.basis === 'provided_assessment' && item.fields.collaboration_profile.psychometric_summary && <small>Metodă furnizată: {item.fields.collaboration_profile.psychometric_method}. {item.fields.collaboration_profile.psychometric_summary}</small>}</span></div>}
    {isHeld && <div className="ctx-held-note"><AlertCircle size={14} />Afirmația necesită clarificare înainte de acceptare ({item.conflict ? 'conflict' : item.stale ? 'date schimbate' : 'câmp nerezolvat'}).</div>}
    {item.review_state === 'manager_confirmed' && <div className="ctx-reviewed-note"><CheckCheck size={14} />Acceptată de manager</div>}
    {actionError && <div className="ctx-action-error" role="alert"><AlertCircle size={14} />{actionError}</div>}
    {item.review_state !== 'manager_confirmed' && <div className="ctx-fact-actions">
      {!mode && <><button type="button" className="ctx-confirm-button" onClick={handleAccept} disabled={isBusy || isHeld}><Check size={15} />Confirmă</button><button type="button" className="ctx-secondary-button" onClick={() => { setMode('correct'); setReason(''); setActionError(''); }} disabled={isBusy}>Corectează</button><button type="button" className="ctx-secondary-button ctx-reject-button" onClick={() => { setMode('reject'); setReason(''); setActionError(''); }} disabled={isBusy}>Respinge</button></>}
      {mode === 'reject' && <form className="ctx-review-form" onSubmit={handleReject}><strong>Motivul respingerii</strong><input autoFocus value={reason} onChange={(event) => setReason(event.target.value)} placeholder="ex. Citatul nu susține afirmația" required /><div><button type="button" className="ctx-secondary-button" onClick={() => setMode(null)}>Renunță</button><button type="submit" className="ctx-reject-button" disabled={isBusy || !reason.trim()}>{busy ? 'Se salvează…' : 'Respinge afirmația'}</button></div></form>}
      {mode === 'correct' && <form className="ctx-review-form" onSubmit={handleCorrection}><strong>Corectează afirmația</strong><div className="ctx-correction-fields"><label>Titlu<input autoFocus value={draft.title} onChange={(event) => update('title', event.target.value)} required /></label><label>Responsabil<input value={draft.owner} onChange={(event) => update('owner', event.target.value)} /></label><label>Stare<input value={draft.status} onChange={(event) => update('status', event.target.value)} /></label><label>Termen<input type="date" value={draft.due} onChange={(event) => update('due', event.target.value)} /></label><label className="ctx-wide-field">Descriere<textarea rows={3} value={draft.description} onChange={(event) => update('description', event.target.value)} /></label></div><label className="ctx-reason-field">Motivul corectării<input value={reason} onChange={(event) => setReason(event.target.value)} placeholder="ex. Termenul corect este cel din rândul 18" required /></label><div><button type="button" className="ctx-secondary-button" onClick={() => setMode(null)}>Renunță</button><button type="submit" className="ctx-confirm-button" disabled={isBusy || !reason.trim()}>{busy ? 'Se salvează…' : 'Salvează corectarea'}</button></div></form>}
    </div>}
  </article>;
}

function SourceInspector({ workspace, source, facts, records, focusRef, onDecide, onReviewItem, onOpenSource, onOpenRecord, onRetry, retrying, proposalBusyId }: {
  workspace: ProjectWorkspace; source: ProjectSource; facts: SourceFact[]; records: SourceRecordFact[];
  focusRef?: SourceRef | null;
  onDecide: ContextWorkspaceProps['onDecide']; onReviewItem: ContextWorkspaceProps['onReviewItem']; onOpenSource: (ref: SourceRef) => void;
  onOpenRecord: ContextWorkspaceProps['onOpenRecord']; onRetry: ContextWorkspaceProps['onRetry']; retrying: boolean; proposalBusyId: string;
}) {
  const lifecycle = sourceLifecycle(workspace, source);
  const statusText = source.parser_status === 'parsed' ? 'Text citit' : source.parser_status === 'unsupported' ? 'Format nesuportat' : source.parser_status === 'failed' ? 'Citire eșuată' : 'Fără text extras';
  return <aside className="ctx-inspector">
    <div className="ctx-inspector-top"><div className="ctx-file-type">{sourceType(source).slice(0, 4)}</div><div><span className="ctx-eyebrow">INSPECTOR DE SURSĂ</span><h2>{source.name}</h2><p>{sourceType(source)}{source.size ? ` · ${formatBytes(source.size)}` : ''} · {statusText}</p></div></div>
    {focusRef?.source_id === source.id && <div className="ctx-focused-citation" aria-live="polite"><div><ShieldCheck size={14} /><strong>Citatul deschis</strong><span>{focusRef.location || 'Locație neînregistrată'}</span></div><blockquote>„{focusRef.quote}”</blockquote></div>}
    <div className="ctx-inspector-section"><h3>Verifică extragerea</h3><p>{lifecycle.pendingCount ? `${lifecycle.pendingCount} ${lifecycle.pendingCount === 1 ? 'afirmație propusă' : 'afirmații propuse'} din această sursă.` : lifecycle.hasFacts ? 'Afirmațiile asociate acestei surse sunt păstrate în proiect.' : source.extraction_coverage === 'complete' ? 'Extragerea s-a încheiat fără afirmații propuse.' : 'Nu există încă o extragere confirmată pentru această sursă.'}</p>
      {source.error && <div className="ctx-source-error"><AlertCircle size={14} />{source.error}</div>}
      {source.coverage_note && <small className="ctx-coverage-note">{source.coverage_note}</small>}
      {source.extraction_note && <small className="ctx-coverage-note">{extractionNote(source)}</small>}
      {source.parser_status === 'parsed' && !source.fixture_only && source.extraction_coverage === 'complete' && <button type="button" className="ctx-retry-button" onClick={() => onRetry([source.id], { reprocess: true })} disabled={retrying}>{retrying ? 'Se reanalizează…' : 'Reanalizează sursa'}</button>}
    </div>
    {facts.length > 0 && <div className="ctx-inspector-section ctx-reviewable-facts"><h3>Afirmații de revizuit</h3>{facts.map((fact) => {
      const busy = proposalBusyId === fact.proposal.id || proposalBusyId === `${fact.proposal.id}:${fact.item.id}` || proposalBusyId.startsWith(`${fact.proposal.id}:`);
      return <FactReviewCard key={`${fact.proposal.id}:${fact.item.id}`} fact={fact} source={source} busy={busy} onDecide={onDecide} onReviewItem={onReviewItem} onOpenSource={onOpenSource} />;
    })}</div>}
    {!facts.length && records.length > 0 && <div className="ctx-inspector-section"><h3>Afirmații acceptate</h3>{records.map(({ record, ref }, index) => <article className="ctx-accepted-record" key={`${record.id}:${index}`}><div><strong>{record.title}</strong><span>{kindLabels[record.kind] || record.kind} · {ref.location || 'Locație neînregistrată'}</span></div>{ref.quote && <blockquote>„{ref.quote}”</blockquote>}{['member', 'task', 'deliverable'].includes(record.kind) && <button type="button" onClick={() => onOpenRecord(record.kind as 'member' | 'task' | 'deliverable', record.id)}>Deschide în hartă <ArrowRight size={12} /></button>}{ref.quote && <button type="button" onClick={() => onOpenSource(ref)}>Deschide sursa <ArrowUpRight size={12} /></button>}</article>)}</div>}
    {!facts.length && !records.length && <div className="ctx-no-facts"><Info size={16} /><span>Nicio afirmație cu citat exact nu este asociată acestei surse. Starea de revizuire nu este marcată ca finalizată.</span></div>}
    {source.excerpt && <details className="ctx-excerpt-disclosure"><summary>Deschide fragmentul sursei</summary><div className="ctx-excerpt"><span>Previzualizare informativă</span><p>{source.excerpt}</p><small>Fragment informativ, nu dovadă exactă.</small></div></details>}
  </aside>;
}

export default function ContextWorkspace(props: ContextWorkspaceProps) {
  const { workspace } = props;
  const [selectedSourceId, setSelectedSourceId] = useState('');
  const lifecycleById = useMemo(() => new Map(workspace.sources.map((source) => [source.id, sourceLifecycle(workspace, source)])), [workspace]);
  const pendingCount = useMemo(() => workspace.proposals.filter((proposal) => proposal.status === 'proposed').reduce((count, proposal) => count + proposal.items.filter((item) => item.review_state !== 'manager_confirmed').length, 0), [workspace.proposals]);
  const initialSource = preferredSourceId(workspace);
  useEffect(() => {
    if (props.focusSourceId && workspace.sources.some((source) => source.id === props.focusSourceId)) { setSelectedSourceId(props.focusSourceId); return; }
    if (!workspace.sources.some((source) => source.id === selectedSourceId)) setSelectedSourceId(initialSource);
  }, [workspace.project.id, workspace.sources, workspace.proposals, props.focusSourceId, initialSource, selectedSourceId]);
  const selectedSource = workspace.sources.find((source) => source.id === selectedSourceId) || null;
  const selectedFacts = selectedSource ? pendingSourceFacts(workspace, selectedSource.id) : [];
  const selectedRecords = selectedSource ? acceptedSourceFacts(workspace, selectedSource.id) : [];
  useEffect(() => {
    if (!props.focusSourceId && !props.focusRef) return;
    if (window.matchMedia('(max-width: 1000px)').matches) requestAnimationFrame(() => document.querySelector('.ctx-inspector')?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  }, [props.focusSourceId, props.focusRef?.quote, selectedSourceId]);

  return <section className="context-v7">
    <header className="context-v7-heading"><div><h1>Contextul proiectului</h1>{workspace.project.synthetic && <span className="context-v7-demo-label">Exemplu sintetic · {workspace.members.filter((member) => member.member_type === 'person').length} membri · {workspace.tasks.length} sarcini</span>}</div><div className="context-v7-heading-actions">{props.toolbarContent}<button type="button" className="context-v7-add-button" onClick={props.onAddSources}><Plus size={18} />Adaugă surse</button></div></header>
    <nav className="context-v7-tabs" role="tablist" aria-label="Contextul proiectului">
      {tabLabels.map(({ id, label }) => <button type="button" role="tab" aria-selected={props.tab === id} className={`context-v7-tab ${props.tab === id ? 'context-v7-tab-active' : ''}`} key={id} onClick={() => props.onTabChange(id)}>
        {id === 'history' && <History size={15} />}{label}{id === 'review' && <span className={`context-v7-pending-count ${pendingCount ? '' : 'is-zero'}`}>{pendingCount}</span>}
      </button>)}
    </nav>
    {props.tab === 'sources' && <>
      <div className="context-v7-source-layout">
        <div className="context-v7-source-column">
          <section className="ctx-source-list-card" aria-label="Lista surselor proiectului">
            <div className={`ctx-extraction-status ${pendingCount ? 'has-pending' : ''}`} role="status">
              <span className="ctx-extraction-status-mark">{pendingCount ? <AlertCircle size={17} /> : <CheckCheck size={17} />}</span>
              <span className="ctx-extraction-status-copy"><strong>{pendingCount ? 'Date extrase.' : workspace.sources.some((source) => sourceLifecycle(workspace, source).hasFacts) ? 'Date extrase și verificate.' : workspace.sources.some((source) => source.extraction_coverage === 'complete') ? 'Extragerea s-a încheiat.' : workspace.sources.some((source) => source.parser_status === 'parsed') ? 'Fișierele sunt citite; extragerea nu este confirmată.' : 'Adaugă surse pentru a începe.'}</strong>
                {pendingCount > 0 && <small>Mai sunt {pendingCount} de verificat.</small>}
                {!pendingCount && !workspace.sources.some((source) => sourceLifecycle(workspace, source).hasFacts) && workspace.sources.some((source) => source.extraction_coverage === 'complete') && <small>Nu au fost găsite afirmații cu citat asociat.</small>}
              </span>
              {pendingCount > 0 && <button type="button" onClick={() => props.onTabChange('review')}>De verificat <ArrowRight size={14} /></button>}
            </div>
            <div className="ctx-source-list-summary"><strong>{workspace.sources.length} {workspace.sources.length === 1 ? 'sursă' : 'surse'}</strong><span>·</span><strong>{pendingCount} {pendingCount === 1 ? 'verificare rămasă' : 'verificări rămase'}</strong></div>
            <div className="ctx-source-table-scroll">
              <div className="ctx-source-grid ctx-source-grid-head" aria-hidden="true"><span>Sursă</span><span>Încărcat</span><span>Procesat</span><span>Extras</span><span>Verificat</span></div>
              {workspace.sources.length ? workspace.sources.map((source) => {
                const lifecycle = lifecycleById.get(source.id)!;
                const selected = source.id === selectedSourceId;
                return <button type="button" className={`ctx-source-grid ctx-source-row ${selected ? 'ctx-source-row-selected' : ''}`} key={source.id} onClick={() => { setSelectedSourceId(source.id); props.onClearFocus?.(); }} aria-selected={selected}>
                  <span className="ctx-source-name-cell"><span className={`ctx-source-file-icon ctx-file-${sourceType(source).toLowerCase()}`}><FileText size={18} /></span><span><strong>{source.name}</strong><small>{sourceType(source)}{source.size ? ` · ${formatBytes(source.size)}` : ''}</small></span></span>
                  <PhaseMark label="Încărcat" phase="loaded" state={lifecycle.loaded} source={source} lifecycle={lifecycle} />
                  <PhaseMark label="Procesat" phase="parsed" state={lifecycle.parsed} source={source} lifecycle={lifecycle} />
                  <PhaseMark label="Extras" phase="extraction" state={lifecycle.extraction} source={source} lifecycle={lifecycle} />
                  <PhaseMark label="Verificat" phase="review" state={lifecycle.review} source={source} lifecycle={lifecycle} />
                </button>;
              }) : <div className="ctx-source-empty"><FileText size={20} /><strong>Nu există încă surse</strong><p>Adaugă documente pentru a păstra textul, starea parserului și citatele asociate.</p><button type="button" className="context-v7-add-button" onClick={props.onAddSources}><Plus size={16} />Adaugă surse</button></div>}
            </div>
          </section>
          {props.retryResult && <div className="ctx-retry-result" role="status">{props.retryResult}</div>}
          <IntegrationPanel projectId={workspace.project.id} provider={props.provider} connections={props.connections} storageMode={props.storageMode} presentationDemo={isPresentationDemo(workspace)} />
        </div>
        {selectedSource ? <SourceInspector workspace={workspace} source={selectedSource} facts={selectedFacts} records={selectedRecords} focusRef={props.focusRef} onDecide={props.onDecide} onReviewItem={props.onReviewItem} onOpenSource={props.onOpenSource} onOpenRecord={props.onOpenRecord} onRetry={props.onRetry} retrying={props.retrying} proposalBusyId={props.proposalBusyId} /> : <aside className="ctx-inspector ctx-inspector-empty"><Info size={20} /><span>Selectează o sursă pentru detalii și afirmații citate.</span></aside>}
      </div>
      {props.onOpenMap && <div className="ctx-map-notice"><span><Check size={19} /></span><strong>Datele confirmate apar în hartă</strong><button type="button" onClick={props.onOpenMap}>Deschide harta <ArrowRight size={15} /></button></div>}
    </>}
    {props.tab === 'review' && <div className="context-v7-embedded"><div className="ctx-embedded-heading"><div><h2>De verificat</h2><p>Revizuiește fiecare afirmație și citatul ei înainte ca proiectul să se schimbe.</p></div><span>{pendingCount} în așteptare</span></div><div className="ctx-embedded-content">{props.reviewContent || <div className="ctx-embedded-empty"><CheckCheck size={19} /><strong>Nu există schimbări propuse în așteptare</strong><p>Importurile și notele noi vor apărea aici pentru revizuire.</p></div>}</div></div>}
    {props.tab === 'history' && <div className="context-v7-embedded"><div className="ctx-embedded-heading"><div><h2>Istoric</h2><p>Acțiunile de revizuire și modificările acceptate ale proiectului.</p></div></div><div className="ctx-embedded-content">{props.historyContent || <div className="ctx-embedded-empty"><History size={19} /><strong>Istoricul este gol</strong></div>}</div></div>}
  </section>;
}
