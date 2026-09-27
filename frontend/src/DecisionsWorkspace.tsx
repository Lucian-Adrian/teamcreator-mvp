import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, ArrowRight, CalendarDays, Check, CheckCircle2, ChevronDown, ChevronRight, CircleHelp, Clock3, Copy, Download, FileText, History, Link2, Mail, MessageSquare, Play, RotateCcw, Save, ShieldCheck } from 'lucide-react';
import type { ProjectProposal, ProjectRecord, ProjectWorkspace, RecordKind, SourceRef } from '../../shared/types';
import type { SimulationIntervention, SimulationOutput, SimulationResult } from '../../shared/simulation';
import ReportsWorkspace from './ReportsWorkspace';
import './decisions-workspace.css';

type DecisionTab = 'pending' | 'applied' | 'reports';
type DraftChannel = 'email' | 'teams';
type ReviewBody = { action: 'reject' | 'correct'; reason: string; fields?: Record<string, unknown> };

export interface DecisionsWorkspaceProps {
  workspace: ProjectWorkspace;
  simulationOutput?: SimulationOutput | null;
  focusedRecordId?: string | null;
  onReviewProposalItem: (proposalId: string, itemId: string, body: ReviewBody) => Promise<void>;
  onApplyProposalItems: (proposalId: string, itemIds: string[]) => Promise<void>;
  onSaveRecord: (kind: string, id: string, fields: Record<string, unknown>) => Promise<void>;
  onRunScenario: (intervention: SimulationIntervention) => void;
  onRunSimulation?: () => void;
  onOpenSource?: (ref: SourceRef) => void;
  onOpenRecord?: (kind: RecordKind, id: string) => void;
}

interface DecisionItem {
  key: string;
  title: string;
  subtitle: string;
  summary: string;
  due: string | null;
  record?: ProjectRecord;
  proposal?: ProjectProposal;
  proposalItem?: ProjectProposal['items'][number];
  sourceRefs: SourceRef[];
  pending: boolean;
}

const weekdayOptions = [
  { day: 1, label: 'Lu' }, { day: 2, label: 'Ma' }, { day: 3, label: 'Mi' }, { day: 4, label: 'Jo' },
  { day: 5, label: 'Vi' }, { day: 6, label: 'Sâ' }, { day: 0, label: 'Du' },
];

const statusOptions = [
  { value: 'needs_confirmation', label: 'Necesită confirmare' },
  { value: 'recommended_question', label: 'Întrebare recomandată' },
  { value: 'planned', label: 'Planificat' },
  { value: 'in_progress', label: 'În lucru' },
  { value: 'blocked', label: 'Blocat' },
  { value: 'done', label: 'Finalizat' },
  { value: 'rejected', label: 'Respins' },
];

export default function DecisionsWorkspace({ workspace, simulationOutput, focusedRecordId, onReviewProposalItem, onApplyProposalItems, onSaveRecord, onRunScenario, onRunSimulation, onOpenSource, onOpenRecord }: DecisionsWorkspaceProps) {
  const [tab, setTab] = useState<DecisionTab>('pending');
  const [selectedKey, setSelectedKey] = useState('');
  const [query, setQuery] = useState('');
  const [error, setError] = useState('');
  const [busyKey, setBusyKey] = useState('');
  const [editProposal, setEditProposal] = useState(false);
  const [editRecord, setEditRecord] = useState(false);
  const [editTitle, setEditTitle] = useState('');
  const [editDescription, setEditDescription] = useState('');
  const [editStatus, setEditStatus] = useState('');
  const [reason, setReason] = useState('');
  const [rejectOpen, setRejectOpen] = useState(false);
  const [scenarioKind, setScenarioKind] = useState<'duration_shift' | 'capacity'>('duration_shift');
  const [scenarioTaskId, setScenarioTaskId] = useState('');
  const [scenarioMemberId, setScenarioMemberId] = useState('');
  const [scenarioDays, setScenarioDays] = useState('');
  const [scenarioAvailability, setScenarioAvailability] = useState('');
  const [draftChannel, setDraftChannel] = useState<DraftChannel>('email');
  const [draftRecipient, setDraftRecipient] = useState('');
  const [draftSubject, setDraftSubject] = useState('');
  const [draftBody, setDraftBody] = useState('');
  const [draftFeedback, setDraftFeedback] = useState('');

  const allRecords = useMemo(() => [...workspace.tasks, ...workspace.deliverables, ...workspace.decisions, ...workspace.risks], [workspace]);
  const inbox = useMemo(() => collectInbox(workspace), [workspace]);
  const searchedInbox = inbox.filter((item) => `${item.title} ${item.subtitle} ${item.summary}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const selected = searchedInbox.find((item) => item.key === selectedKey) || inbox.find((item) => item.key === selectedKey) || searchedInbox[0] || null;
  const completedItems = useMemo(() => collectApplied(workspace), [workspace]);
  const appliedCount = completedItems.length;
  const latestResult = resultOf(simulationOutput);
  const selectedSourceSignature = (selected?.sourceRefs || []).map((ref) => `${ref.source_id}:${ref.location}:${ref.quote}`).join('|');
  const recordedOwner = selected ? recordedOwnerName(selected, workspace) : '';
  const draftDefaults = useMemo(() => selected ? createDraftDefaults(selected, workspace, recordedOwner) : null, [
    selected?.key, selected?.title, selected?.summary, selected?.due, selectedSourceSignature, workspace.project.id, recordedOwner,
  ]);

  useEffect(() => {
    if (focusedRecordId) {
      const match = inbox.find((item) => item.record?.id === focusedRecordId || item.proposalItem?.record_id === focusedRecordId);
      if (match) { setSelectedKey(match.key); setTab('pending'); return; }
    }
    if (!inbox.some((item) => item.key === selectedKey)) setSelectedKey(inbox[0]?.key || '');
  }, [focusedRecordId, inbox, selectedKey]);

  useEffect(() => {
    setEditProposal(false); setEditRecord(false); setRejectOpen(false); setError(''); setReason('');
    setEditTitle(selected?.proposalItem?.title || selected?.record?.title || '');
    setEditDescription(String(selected?.proposalItem?.fields.description || selected?.record?.description || ''));
    setEditStatus(String(selected?.record?.status || ''));
  }, [selected?.key]);

  useEffect(() => {
    setDraftRecipient(draftDefaults?.recipient || '');
    setDraftSubject(draftDefaults?.subject || '');
    setDraftBody(draftDefaults?.body || '');
    setDraftFeedback('');
  }, [draftDefaults]);

  const affected = selected ? affectedRecords(selected, allRecords) : [];
  const relatedRisks = selected ? risksRelatedTo(selected, workspace.risks) : [];
  const selectedItem = selected?.proposalItem;
  const sourceRefs = selected?.sourceRefs || [];

  const runScenario = () => {
    if (scenarioKind === 'duration_shift') {
      const days = Number(scenarioDays);
      const task = workspace.tasks.find((item) => item.id === scenarioTaskId);
      if (!task || !Number.isFinite(days)) return setError('Alege o sarcină și introdu ajustarea în zile.');
      onRunScenario({ kind: 'duration_shift', taskId: task.id, days, label: `Ajustare testată · ${task.title} · ${formatSigned(days)} zile` });
    } else {
      const availability = Number(scenarioAvailability);
      const member = workspace.members.find((item) => item.id === scenarioMemberId);
      if (!member || !Number.isFinite(availability) || availability <= 0 || availability > 100) return setError('Alege un membru și introdu disponibilitatea propusă între 1% și 100%.');
      onRunScenario({ kind: 'capacity', memberId: member.id, availabilityFraction: availability / 100, label: `Capacitate testată · ${member.title} · ${availability}%` });
    }
  };

  const applyProposalItem = async () => {
    if (!selected?.proposal || !selectedItem) return;
    await perform(`apply:${selected.key}`, () => onApplyProposalItems(selected.proposal!.id, [selectedItem.id]));
  };

  const saveProposalCorrection = async () => {
    if (!selected?.proposal || !selectedItem || !reason.trim()) return setError('Scrie motivul corecției înainte de salvare.');
    await perform(`correct:${selected.key}`, () => onReviewProposalItem(selected.proposal!.id, selectedItem.id, {
      action: 'correct', reason: reason.trim(), fields: { title: editTitle.trim(), description: editDescription.trim() || null },
    }));
    setEditProposal(false);
  };

  const rejectProposalItem = async () => {
    if (!selected?.proposal || !selectedItem || !reason.trim()) return setError('Scrie motivul respingerii înainte de continuare.');
    await perform(`reject:${selected.key}`, () => onReviewProposalItem(selected.proposal!.id, selectedItem.id, { action: 'reject', reason: reason.trim() }));
    setRejectOpen(false);
  };

  const saveCurrentDecision = async () => {
    if (!selected?.record || !reason.trim()) return setError('Scrie motivul editării înainte de salvare.');
    await perform(`save:${selected.key}`, () => onSaveRecord('decision', selected.record!.id, {
      title: editTitle.trim(), description: editDescription.trim() || null, status: editStatus.trim() || null, reason: reason.trim(),
    }));
    setEditRecord(false);
  };

  async function perform(key: string, action: () => Promise<void>) {
    setBusyKey(key); setError('');
    try { await action(); }
    catch (reasonValue) { setError(reasonValue instanceof Error ? reasonValue.message : 'Acțiunea nu a putut fi salvată.'); }
    finally { setBusyKey(''); }
  }

  const copyDraft = async () => {
    try {
      await navigator.clipboard.writeText(serializeDraft(draftChannel, draftRecipient, draftSubject, draftBody));
      setDraftFeedback('Ciorna a fost copiată. Nu a fost trimisă.');
    } catch {
      setDraftFeedback('Clipboard indisponibil. Poți descărca textul.');
    }
  };

  const downloadDraft = () => {
    const file = new Blob([serializeDraft(draftChannel, draftRecipient, draftSubject, draftBody)], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(file);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `ciorna-${fileSlug(selected?.title || 'mesaj')}.txt`;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
    setDraftFeedback('Ciorna a fost descărcată. Nu a fost trimisă.');
  };

  return <section className="tc-decisions-workspace" aria-label={tab === 'reports' ? 'Rapoarte de proiect' : undefined} aria-labelledby={tab === 'reports' ? undefined : 'tc-decisions-title'}>
    {tab !== 'reports' && <header className="tc-decisions-header">
      <div><span className="tc-decisions-eyebrow"><ShieldCheck size={14} /> INBOX DE DECIZII</span><h1 id="tc-decisions-title">Decizii</h1></div>
      <div className="tc-decisions-header-meta"><span><CircleHelp size={14} /> Ipotezele modelului nu sunt modificări aplicate.</span><span>{workspace.project.name}</span></div>
    </header>}

    <nav className="tc-decisions-tabs" role="tablist" aria-label="Panouri de decizie">
      <button type="button" role="tab" aria-selected={tab === 'pending'} className={tab === 'pending' ? 'active' : ''} onClick={() => setTab('pending')}>De decis <b>{inbox.length}</b></button>
      <button type="button" role="tab" aria-selected={tab === 'applied'} className={tab === 'applied' ? 'active' : ''} onClick={() => setTab('applied')}>Aplicate <b>{appliedCount}</b></button>
      <button type="button" role="tab" aria-selected={tab === 'reports'} className={tab === 'reports' ? 'active' : ''} onClick={() => setTab('reports')}>Rapoarte</button>
      <span className="tc-decisions-tab-spacer" />
      {tab === 'pending' && <label className="tc-decisions-search"><span>Caută</span><input aria-label="Caută o decizie" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Decizie, risc sau sarcină" /></label>}
    </nav>

    {error && <div className="tc-decision-error" role="alert"><AlertTriangle size={15} /><span>{error}</span></div>}

    {tab === 'pending' && <div className="tc-decisions-split">
      <aside className="tc-decision-inbox" aria-label="Elemente de revizuit">
        {searchedInbox.length ? searchedInbox.map((item) => <button type="button" key={item.key} className={`tc-decision-inbox-item${selected?.key === item.key ? ' active' : ''}`} onClick={() => setSelectedKey(item.key)}>
          <span className={`tc-decision-type-mark ${item.pending ? 'pending' : 'record'}`}>{item.pending ? <Clock3 size={16} /> : <CheckCircle2 size={16} />}</span>
          <span className="tc-decision-inbox-copy"><strong>{item.title}</strong><small>{item.subtitle}</small></span>
          <span className="tc-decision-inbox-date">{item.due ? formatDate(item.due) : item.pending ? 'De verificat' : 'Necunoscut'}</span><ChevronRight size={15} />
        </button>) : <div className="tc-decision-empty"><CheckCircle2 size={22} /><strong>{query ? 'Niciun rezultat pentru această căutare' : 'Nu sunt decizii în așteptare'}</strong><p>Propunerile și deciziile aprobate apar aici când sunt înregistrate în proiect.</p></div>}
      </aside>

      {selected ? <main className="tc-decision-detail">
        <div className="tc-decision-detail-heading"><div className="tc-decision-heading-icon"><FileText size={18} /></div><div><span className="tc-decisions-eyebrow">{selected.proposalItem ? 'PROPUNERE · NECONFIRMATĂ' : selected.record && isPmReviewed(selected.record) ? 'REVIZUITĂ DE PM' : 'DE VERIFICAT · NECONFIRMATĂ'}</span><h2>{selected.title}</h2></div></div>
        {selected.summary && <p className="tc-decision-summary">{selected.summary}</p>}

        <section className="tc-decision-evidence-section">
          <div className="tc-decision-section-heading"><h3>Surse</h3><span>{sourceRefs.length ? `${sourceRefs.length} citate atașate` : 'Nicio sursă atașată'}</span></div>
          {sourceRefs.length ? <>
            <div className="tc-decision-source-chips">{sourceRefs.map((ref, index) => <button type="button" className="tc-decision-source-chip" key={`${ref.source_id}:${ref.location}:${index}`} onClick={() => onOpenSource?.(ref)} disabled={!onOpenSource} title={ref.quote}>
              <FileText size={13} /><span>{sourceName(workspace, ref)}</span><small>{ref.location}</small>
            </button>)}</div>
            <details className="tc-decision-quotes"><summary>Vezi citatele exacte</summary><div>{sourceRefs.map((ref, index) => <blockquote key={`${ref.source_id}:${ref.location}:${index}`}><span>{sourceName(workspace, ref)} · {ref.location}</span><p>„{ref.quote}”</p></blockquote>)}</div></details>
          </> : <p className="tc-decision-unknown">Nu există un citat atașat. Contextul sursei rămâne necunoscut.</p>}
        </section>

        <section className="tc-decision-context-grid">
          <div className="tc-decision-context-card"><div className="tc-decision-section-heading"><h3>Riscuri legate de aceleași surse</h3><AlertTriangle size={15} /></div>
            {relatedRisks.length ? relatedRisks.map((risk) => <div className="tc-decision-risk-row" key={risk.id}><strong>{risk.title}</strong><small>{displayStatus(risk.status)} · {isPmReviewed(risk) ? 'revizuit de PM' : 'neconfirmat'}</small><div className="tc-decision-source-chips compact">{risk.source_refs.slice(0, 2).map((ref) => <button type="button" className="tc-decision-source-chip" key={`${ref.source_id}:${ref.location}`} onClick={() => onOpenSource?.(ref)} disabled={!onOpenSource}><FileText size={12} /><span>{sourceName(workspace, ref)}</span><small>{ref.location}</small></button>)}</div></div>) : <p className="tc-decision-unknown">Nicio legătură explicită prin ID sau sursă în datele disponibile.</p>}
          </div>
          <div className="tc-decision-context-card"><div className="tc-decision-section-heading"><h3>Dependențe afectate</h3><Link2 size={15} /></div>
            {affected.length ? <div className="tc-decision-affected-list">{affected.map((record) => <button type="button" key={record.id} onClick={() => onOpenRecord?.(record.kind, record.id)} disabled={!onOpenRecord}><span>{record.kind === 'deliverable' ? 'Livrabil' : 'Sarcină'}</span><strong>{record.title}</strong><small>{displayStatus(record.status)} · {record.due ? formatDate(record.due) : 'termen necunoscut'}</small></button>)}</div> : <p className="tc-decision-unknown">Nicio dependență explicită găsită în registrul curent.</p>}
          </div>
        </section>

        <section className="tc-decision-options">
          <div className="tc-decision-section-heading"><div><h3>Opțiuni</h3><p>Baseline-ul și intervenția sunt calculate separat; intervenția rămâne neaplicată.</p></div><span className="tc-decision-model-tag">{latestResult ? `${latestResult.iterations.toLocaleString('ro-RO')} rulări` : 'Nicio rulare'}</span></div>
          {simulationOutput?.kind === 'simulation_comparison' ? <div className="tc-decision-paired-options">
            <article className="tc-decision-option-card baseline"><small>Baseline · plan curent</small><strong>{simulationOutput.baseline.completionDates.p50}</strong><span>P50 · {formatDays(simulationOutput.baseline.completionDays.p50)}</span><em>{simulationOutput.baseline.deadlineOutlook ? `${formatPercent(simulationOutput.baseline.deadlineOutlook.onTime.share)} din eșantion la termen` : 'Termenul țintă nu este configurat'}</em></article>
            <ArrowRight size={17} />
            <article className="tc-decision-option-card scenario"><small>Intervenție · neaplicată</small><strong>{simulationOutput.scenario.completionDates.p50}</strong><span>{simulationOutput.intervention.label}</span><em>{simulationOutput.scenario.deadlineOutlook ? `${formatPercent(simulationOutput.scenario.deadlineOutlook.onTime.share)} din eșantion la termen` : 'Termenul țintă nu este configurat'}</em></article>
            <p>Pereche modelată cu aceleași extrageri aleatoare · seed {simulationOutput.baseline.seed} · config {simulationOutput.configFingerprint.slice(0, 12)}. Nu este un efect observat și nu s-a aplicat nicio schimbare.</p>
          </div> : <div className="tc-decision-paired-options">
            <article className="tc-decision-option-card baseline"><small>Baseline · plan curent</small><strong>{latestResult?.completionDates.p50 || 'Rulare necesară'}</strong><span>{latestResult ? `P50 · ${formatDays(latestResult.completionDays.p50)}` : 'Nu există un rezultat numeric curent.'}</span><em>{latestResult?.deadlineOutlook ? `${formatPercent(latestResult.deadlineOutlook.onTime.share)} din eșantion la termen` : 'Rezultatul față de termen este necunoscut'}</em></article>
            <ArrowRight size={17} />
            <article className="tc-decision-option-card scenario"><small>Intervenție · ipoteză</small><strong>De configurat</strong><span>Alege o sarcină ori o capacitate explicită.</span><em>Nicio schimbare nu se aplică automat.</em></article>
          </div>}

          <div className="tc-decision-scenario-form">
            <label>Tip comparație<select value={scenarioKind} onChange={(event) => setScenarioKind(event.target.value as typeof scenarioKind)}><option value="duration_shift">Ajustare de durată</option><option value="capacity">Disponibilitate membru</option></select></label>
            {scenarioKind === 'duration_shift' ? <><label>Sarcină<select value={scenarioTaskId} onChange={(event) => setScenarioTaskId(event.target.value)}><option value="">Alege o sarcină</option>{workspace.tasks.map((task) => <option key={task.id} value={task.id}>{task.title}</option>)}</select></label><label>Ajustare testată, zile<input type="number" step="0.5" value={scenarioDays} onChange={(event) => setScenarioDays(event.target.value)} placeholder="ex. -1" /></label></> : <><label>Membru<select value={scenarioMemberId} onChange={(event) => setScenarioMemberId(event.target.value)}><option value="">Alege un membru</option>{workspace.members.map((member) => <option key={member.id} value={member.id}>{member.title}</option>)}</select></label><label>Disponibilitate propusă %<input type="number" min="1" max="100" step="1" value={scenarioAvailability} onChange={(event) => setScenarioAvailability(event.target.value)} placeholder="Introdu valoarea" /></label><p className="tc-decision-unknown full">Capacitatea reală rămâne necunoscută până la confirmare. Notițele de disponibilitate nu sunt convertite automat în ore sau procente.</p></>}
            <button type="button" className="tc-decision-primary" onClick={runScenario} disabled={scenarioKind === 'duration_shift' ? !scenarioTaskId || !scenarioDays.trim() : !scenarioMemberId || !scenarioAvailability.trim()}><Play size={14} /> Rulează comparația pereche</button>
          </div>
          {latestResult && <div className="tc-decision-capacity-summary"><span>Capacitate în model</span>{workspace.members.map((member) => {
            const capacity = latestResult.config.memberCapacity[member.id];
              return <small key={member.id}>{member.title}: {capacity?.confirmed ? `${Math.round(capacity.availabilityFraction * 100)}% · ${capacity.maxConcurrentTasks} simultan, confirmat în ipoteze` : `necunoscută · ipoteză de test ${capacity ? `${Math.round(capacity.availabilityFraction * 100)}% / ${capacity.maxConcurrentTasks} simultan, neconfirmată` : 'neconfigurată'}`}</small>;
          })}</div>}
        </section>

        <section className="tc-decision-draft-panel" aria-labelledby="tc-decision-draft-title">
          <div className="tc-decision-draft-heading"><div className="tc-decision-heading-icon"><Mail size={18} /></div><div><h3 id="tc-decision-draft-title">Mesaj pregătit</h3><p>Text editabil din înregistrarea selectată și citatele atașate.</p></div><span className="tc-decision-draft-badge">Ciornă · nu se trimite</span></div>
          <div className="tc-decision-draft-grid">
            <label>Destinatar, doar după verificare<input value={draftRecipient} onChange={(event) => setDraftRecipient(event.target.value)} placeholder="Nemenționat în registru" /></label>
            <div className="tc-decision-draft-channel"><span>Canal de pregătire</span><div role="group" aria-label="Canalul mesajului"><button type="button" className={draftChannel === 'email' ? 'active' : ''} aria-pressed={draftChannel === 'email'} onClick={() => setDraftChannel('email')}><Mail size={14} /> Email</button><button type="button" className={draftChannel === 'teams' ? 'active' : ''} aria-pressed={draftChannel === 'teams'} onClick={() => setDraftChannel('teams')}><MessageSquare size={14} /> Teams</button></div></div>
            <label className="tc-decision-draft-subject">{draftChannel === 'email' ? 'Subiect' : 'Titlu mesaj'}<input value={draftSubject} onChange={(event) => setDraftSubject(event.target.value)} /></label>
            <label className="tc-decision-draft-body">Previzualizare editabilă<textarea rows={5} value={draftBody} onChange={(event) => setDraftBody(event.target.value)} /></label>
          </div>
          <div className="tc-decision-draft-actions"><span>{recordedOwner ? `Responsabil consemnat: ${recordedOwner}. Contactul nu este disponibil în registru.` : 'Responsabilul și contactul sunt necunoscute în registru.'}{draftFeedback && ` ${draftFeedback}`}</span><div><button type="button" className="tc-decision-secondary" onClick={() => void copyDraft()}><Copy size={14} /> Copiază textul</button><button type="button" className="tc-decision-secondary" onClick={downloadDraft}><Download size={14} /> Descarcă .txt</button></div></div>
        </section>

        {selected.proposal && selectedItem && <section className="tc-decision-action-panel">
          <div className="tc-decision-section-heading"><div><h3>Revizuire PM</h3><p>Acceptarea aplică numai elementul selectat.</p></div><Clock3 size={15} /></div>
          {editProposal ? <div className="tc-decision-edit-form"><label>Titlu<input value={editTitle} onChange={(event) => setEditTitle(event.target.value)} /></label><label>Descriere<textarea rows={3} value={editDescription} onChange={(event) => setEditDescription(event.target.value)} /></label><label>Motivul corecției<textarea rows={2} value={reason} onChange={(event) => setReason(event.target.value)} placeholder="De ce modifici propunerea?" /></label><div><button type="button" className="tc-decision-primary" disabled={!reason.trim() || Boolean(busyKey)} onClick={() => void saveProposalCorrection()}><Save size={14} /> Salvează corecția</button><button type="button" className="tc-decision-secondary" onClick={() => setEditProposal(false)}>Renunță</button></div><small>Corecția rămâne în așteptare până când o aplici separat.</small></div> : rejectOpen ? <div className="tc-decision-edit-form"><label>Motivul respingerii<textarea rows={2} value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Motiv necesar pentru istoric" /></label><div><button type="button" className="tc-decision-danger" disabled={!reason.trim() || Boolean(busyKey)} onClick={() => void rejectProposalItem()}>Respinge propunerea</button><button type="button" className="tc-decision-secondary" onClick={() => setRejectOpen(false)}>Renunță</button></div></div> : <div className="tc-decision-action-buttons"><button type="button" className="tc-decision-primary" disabled={Boolean(selectedItem.conflict || selectedItem.stale || busyKey)} onClick={() => void applyProposalItem()}><Check size={14} /> Acceptă și aplică</button><button type="button" className="tc-decision-secondary" onClick={() => { setReason(''); setEditProposal(true); }}>Editează înainte de aplicare</button><button type="button" className="tc-decision-danger" onClick={() => { setReason(''); setRejectOpen(true); }}>Respinge</button></div>}
          {selectedItem.conflict || selectedItem.stale ? <p className="tc-decision-unknown">Rezolvă conflictul sau informația depășită înainte de aplicare.</p> : null}
        </section>}

        {selected.record && <section className="tc-decision-action-panel">
          <div className="tc-decision-section-heading"><div><h3>Editare explicită</h3><p>Salvarea va actualiza registrul de decizii și istoricul.</p></div><ShieldCheck size={15} /></div>
          {editRecord ? <div className="tc-decision-edit-form"><label>Titlu<input value={editTitle} onChange={(event) => setEditTitle(event.target.value)} /></label><label>Descriere<textarea rows={3} value={editDescription} onChange={(event) => setEditDescription(event.target.value)} /></label><label>Stare<select value={editStatus} onChange={(event) => setEditStatus(event.target.value)}><option value="">Fără stare</option>{editStatus && !statusOptions.some((option) => option.value === editStatus) && <option value={editStatus}>{displayStatus(editStatus)}</option>}{statusOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label><label>Motivul editării<textarea rows={2} value={reason} onChange={(event) => setReason(event.target.value)} /></label><button type="button" className="tc-decision-primary" disabled={!reason.trim() || Boolean(busyKey)} onClick={() => void saveCurrentDecision()}><Save size={14} /> Salvează editarea</button></div> : <button type="button" className="tc-decision-secondary" onClick={() => { setReason(''); setEditRecord(true); }}>Editează decizia consemnată</button>}
        </section>}
      </main> : <main className="tc-decision-detail tc-decision-empty-detail"><FileText size={25} /><strong>Alege o înregistrare</strong><p>Sursele, riscurile și opțiunile comparate vor apărea aici.</p></main>}
    </div>}

    {tab === 'applied' && <section className="tc-decisions-history" aria-label="Istoric aplicat">{completedItems.length ? completedItems.map((entry) => <article className="tc-decision-history-row" key={entry.key}><span><CheckCircle2 size={16} /></span><div><strong>{entry.title}</strong><p>{entry.summary}</p><small>{entry.date || 'Dată necunoscută'} · {entry.references.length ? entry.references.map((ref) => `${sourceName(workspace, ref)} · ${ref.location}`).join('; ') : 'Fără sursă atașată'}</small></div><span className="tc-decision-applied-tag">Aplicată</span></article>) : <div className="tc-decision-empty"><History size={22} /><strong>Nu există schimbări aplicate de afișat</strong><p>Propunerile aplicate și deciziile închise vor apărea aici.</p></div>}</section>}

    {tab === 'reports' && <ReportsWorkspace workspace={workspace} output={simulationOutput || null} initialAudience="client" onRunSimulation={onRunSimulation} onOpenSource={onOpenSource} />}
    <footer className="tc-decisions-footer"><span>Deciziile și modificările necesită o acțiune explicită a PM-ului.</span><span>{busyKey ? 'Salvez acțiunea…' : 'Nicio modificare nu se aplică din simulare.'}</span></footer>
  </section>;
}

function collectInbox(workspace: ProjectWorkspace): DecisionItem[] {
  const proposed: DecisionItem[] = workspace.proposals.filter((proposal) => proposal.status === 'proposed').flatMap((proposal) => proposal.items
    .filter((item) => item.review_state !== 'manager_confirmed' && item.review_state !== 'manager_corrected' && isDecisionRelevant(item))
    .map((item) => ({
      key: `proposal:${proposal.id}:${item.id}`, title: item.title || item.fields.title || proposal.title,
      subtitle: `${recordKindLabel(item.record_kind)} · ${proposal.title}`, summary: String(item.fields.description || proposal.summary || ''),
      due: item.fields.due || item.fields.current_forecast || null, proposal, proposalItem: item, sourceRefs: item.source_refs || [], pending: true,
    })));
  const existing: DecisionItem[] = workspace.decisions.filter((record) => !isClosed(record.status)).map((record) => ({
    key: `record:${record.id}`, title: record.title, subtitle: `${displayStatus(record.status)} · decizie consemnată · ${isPmReviewed(record) ? 'revizuită de PM' : 'neconfirmată'}`,
    summary: record.description || '', due: record.due || record.current_forecast || record.baseline_due || null, record,
    sourceRefs: record.source_refs || [], pending: true,
  }));
  return [...proposed, ...existing].sort((a, b) => (a.due || '9999-99-99').localeCompare(b.due || '9999-99-99') || a.title.localeCompare(b.title));
}

function collectApplied(workspace: ProjectWorkspace): Array<{ key: string; title: string; summary: string; date: string; references: SourceRef[] }> {
  const proposals = workspace.proposals.filter((proposal) => proposal.status === 'applied').flatMap((proposal) => proposal.items.filter((item) => item.review_state === 'manager_confirmed').map((item) => ({
    key: `proposal:${proposal.id}:${item.id}`, title: item.title, summary: `Aplicată din propunerea „${proposal.title}”.`, date: proposal.decided_at || proposal.created_at, references: item.source_refs || [],
  })));
  const changes = workspace.changes.filter((change) => /proposal_applied|record_edited|record_created/i.test(change.type) && isPmReviewed(change)).map((change) => ({
    key: `change:${change.id}`, title: change.title, summary: change.summary, date: change.at, references: change.source_refs || [],
  }));
  return [...proposals, ...changes].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 40);
}

function isDecisionRelevant(item: ProjectProposal['items'][number]): boolean {
  if (item.record_kind === 'decision' || item.record_kind === 'risk') return true;
  const evidence = [item.title, item.fields.title, item.fields.description, ...item.source_refs.map((ref) => ref.quote)].filter(Boolean).join(' ');
  return /deciz|approve|approval|aprob|beneficiar|client|confirm|budget|buget|review|reviz/i.test(evidence);
}

function isClosed(status: string | null): boolean {
  const normalized = (status || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase().replace(/[^a-z0-9]/g, '');
  return ['done', 'complete', 'completed', 'closed', 'resolved', 'approved', 'accepted', 'applied', 'finalized', 'finalizat', 'finalizata', 'livrat', 'livrata'].includes(normalized);
}

function displayStatus(status: string | null | undefined): string {
  if (!status?.trim()) return 'Stare necunoscută';
  const normalized = status.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase().replace(/[^a-z0-9]/g, '');
  const labels: Record<string, string> = {
    needsconfirmation: 'Necesită confirmare', recommendedquestion: 'Întrebare recomandată',
    notcompleted: 'Neîncheiat', inprogress: 'În lucru', planned: 'Planificat',
    done: 'Finalizat', complete: 'Finalizat', completed: 'Finalizat', finished: 'Finalizat',
    finalized: 'Finalizat', finalizat: 'Finalizat', finalizata: 'Finalizată',
    terminat: 'Finalizat', terminata: 'Finalizată', livrat: 'Livrat', livrata: 'Livrată',
    blocked: 'Blocat', atrisk: 'La risc',
    open: 'Deschis', pending: 'În așteptare', awaitingdecision: 'În așteptarea deciziei',
    approved: 'Aprobat', accepted: 'Acceptat', rejected: 'Respins',
    closed: 'Închis', resolved: 'Rezolvat',
  };
  return labels[normalized] || status.trim().replace(/[_-]+/g, ' ').replace(/^\p{L}/u, (letter) => letter.toLocaleUpperCase());
}

function recordKindLabel(kind: RecordKind): string {
  return kind === 'decision' ? 'Decizie' : kind === 'risk' ? 'Risc' : kind === 'task' ? 'Sarcină' : kind === 'deliverable' ? 'Livrabil' : 'Membru';
}

function isPmReviewed(record: { review_state: string }): boolean { return record.review_state === 'manager_confirmed' || record.review_state === 'manager_corrected'; }

function recordedOwnerName(item: DecisionItem, workspace: ProjectWorkspace): string {
  const ownerId = item.record?.owner_id || item.proposalItem?.fields.owner_id || null;
  const linkedMember = ownerId ? workspace.members.find((member) => member.id === ownerId) : undefined;
  return item.record?.owner?.trim() || item.proposalItem?.fields.owner?.trim() || linkedMember?.title || '';
}

function createDraftDefaults(item: DecisionItem, workspace: ProjectWorkspace, recipient: string): { recipient: string; subject: string; body: string } {
  const sourceLines = item.sourceRefs.flatMap((ref) => [
    `Sursă: ${sourceName(workspace, ref)} · ${ref.location}`,
    ref.quote ? `„${ref.quote}”` : '',
  ]).filter(Boolean);
  const body = [
    recipient ? `Bună, ${recipient},` : '',
    `Te rog să verifici înregistrarea „${item.title}”.`,
    item.summary ? `Descriere consemnată: ${item.summary}` : '',
    item.due ? `Termen consemnat: ${formatDate(item.due)}.` : '',
    ...sourceLines,
    'Te rog să confirmi dacă informația rămâne valabilă sau să indici corectarea necesară.',
  ].filter(Boolean).join('\n\n');
  return { recipient, subject: `Verificare: ${item.title}`, body };
}

function serializeDraft(channel: DraftChannel, recipient: string, subject: string, body: string): string {
  return [
    `Canal pregătit: ${channel === 'email' ? 'Email' : 'Teams'}`,
    `Destinatar: ${recipient.trim() || 'Nespecificat'}`,
    `${channel === 'email' ? 'Subiect' : 'Titlu'}: ${subject.trim() || 'Nespecificat'}`,
    '', body.trim(), '', 'Ciornă locală. Nu a fost trimisă.',
  ].join('\n');
}

function fileSlug(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'mesaj';
}

function affectedRecords(selected: DecisionItem, records: ProjectRecord[]): ProjectRecord[] {
  const origin = selected.proposalItem?.record_id || selected.record?.id;
  if (!origin) return [];
  const affected = new Set<string>();
  let frontier = new Set([origin]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const record of records) {
      if (record.id !== origin && !affected.has(record.id) && record.depends_on.some((id) => frontier.has(id))) {
        affected.add(record.id); changed = true;
      }
    }
    frontier = new Set(records.filter((record) => affected.has(record.id)).map((record) => record.id));
  }
  return records.filter((record) => affected.has(record.id));
}

function risksRelatedTo(selected: DecisionItem, risks: ProjectRecord[]): ProjectRecord[] {
  const sourceIds = new Set(selected.sourceRefs.map((ref) => ref.source_id));
  const recordIds = new Set([selected.record?.id, selected.proposalItem?.record_id].filter((id): id is string => Boolean(id)));
  return risks.filter((risk) => risk.depends_on.some((id) => recordIds.has(id)) || risk.source_refs.some((ref) => sourceIds.has(ref.source_id)));
}

function resultOf(output?: SimulationOutput | null): SimulationResult | null { return !output ? null : output.kind === 'simulation_comparison' ? output.scenario : output; }
function sourceName(workspace: ProjectWorkspace, ref: SourceRef): string { return workspace.sources.find((source) => source.id === ref.source_id)?.relative_path || workspace.sources.find((source) => source.id === ref.source_id)?.name || ref.source_id; }
function formatDate(value: string): string { return /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : value; }
function formatSigned(value: number): string { return `${value > 0 ? '+' : ''}${Number.isInteger(value) ? value : value.toFixed(1)}`; }
function formatDays(value: number): string { return `${Number.isInteger(value) ? value : value.toFixed(1)} zile lucrătoare`; }
function formatPercent(value: number): string { return `${(value * 100).toLocaleString('ro-RO', { maximumFractionDigits: 1 })}%`; }
