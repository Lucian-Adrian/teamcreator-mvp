import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity, AlertCircle, AlertTriangle, ArrowDown, ArrowRight, ArrowUpRight, CalendarDays,
  Check, CheckCircle2, ChevronDown, ChevronRight, CircleHelp, Clock3, FileText, Filter,
  GitBranch, LayoutDashboard, List, LoaderCircle, Network, Plus, Search, Settings2,
  ShieldCheck, Users, X,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { CollaborationProfile, ProjectRecord, ProjectWorkspace, SourceRef } from '../../shared/types';
import { workingDateAtOffset } from '../../shared/simulation';
import type { RemainingWorkForecast, SimulationOutput, SimulationResult } from '../../shared/simulation';
import TeamPeopleMap from './TeamPeopleMap';
import './team-workspace.css';

type Group = 'team' | 'tasks';
type TaskView = 'list' | 'gantt' | 'kanban' | 'burndown' | 'priorities';
type MemberPanel = 'profile' | 'tasks' | 'relations';
type Props = {
  workspace: ProjectWorkspace;
  onOpenSource: (ref: SourceRef) => void;
  onSave: (kind: string, id: string, fields: Record<string, unknown>) => Promise<void>;
  onCreate: (kind?: 'member' | 'task') => void;
  onOpenDecision?: (recordId: string) => void;
  simulationOutput: SimulationOutput | null;
  focusedRecord?: { kind: string; id: string } | null;
};

type GroupedRelation = {
  otherId: string;
  direction: 'outgoing' | 'incoming';
  kind: 'handoff' | 'review' | 'approval' | 'unknown';
  tasks: ProjectRecord[];
  refs: SourceRef[];
};

const taskViews: Array<{ id: TaskView; label: string; icon: LucideIcon }> = [
  { id: 'list', label: 'Listă', icon: List },
  { id: 'gantt', label: 'Gantt', icon: GitBranch },
  { id: 'kanban', label: 'Kanban', icon: LayoutDashboard },
  { id: 'burndown', label: 'Burndown', icon: Activity },
  { id: 'priorities', label: 'Priorități', icon: AlertTriangle },
];

function normalize(value: unknown) {
  return String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLocaleLowerCase();
}

function isCompleted(status: unknown) {
  const token = normalize(status).replace(/[^a-z0-9]/g, '');
  return ['complete', 'completed', 'done', 'finished', 'finalized', 'accepted', 'finalizat', 'finalizata', 'terminat', 'terminata', 'incheiat', 'incheiata'].includes(token);
}

function taskBucket(task: ProjectRecord): 'planned' | 'active' | 'review' | 'waiting' | 'done' {
  const status = normalize(task.status);
  const words = status.replace(/[_-]+/g, ' ');
  if (task.completed_at || isCompleted(status)) return 'done';
  if (['not_started', 'not started', 'planned', 'to do', 'todo', 'backlog', 'de inceput'].includes(status) || ['not started', 'planned', 'to do', 'todo', 'backlog', 'de inceput'].includes(words)) return 'planned';
  if (/review|revizu|verif|validate|validat|approval|aprob/.test(words)) return 'review';
  if (/block|wait|confirm|hold/.test(words)) return 'waiting';
  if (/progress|active|doing|started/.test(words)) return 'active';
  return 'planned';
}

function bucketLabel(bucket: ReturnType<typeof taskBucket>) {
  return ({ planned: 'De început', active: 'În lucru', review: 'În revizuire', waiting: 'În așteptare', done: 'Finalizat' } as const)[bucket];
}

function statusLabel(status: unknown) {
  const value = String(status || '').trim();
  if (!value) return 'Stare necunoscută';
  const labels: Record<string, string> = {
    not_started: 'De început', in_progress: 'În lucru', waiting_for_confirmation: 'Așteaptă confirmarea',
    blocked: 'Blocat', waiting: 'În așteptare', complete: 'Finalizat', completed: 'Finalizat',
    accepted: 'Acceptat', needs_confirmation: 'Necesită confirmare', under_review: 'În revizuire',
  };
  return labels[value.toLowerCase()] || value.replace(/[_-]+/g, ' ').replace(/^./, (first) => first.toLocaleUpperCase());
}

function probabilityPercent(share: number) {
  return `${(share * 100).toFixed(1)}%`;
}

function validDate(value?: string | null) {
  if (!value) return null;
  const date = new Date(`${value.slice(0, 10)}T00:00:00Z`);
  return Number.isFinite(date.getTime()) ? date : null;
}

function formatDate(value?: string | null, options: Intl.DateTimeFormatOptions = { day: '2-digit', month: 'short', year: 'numeric' }) {
  const date = validDate(value);
  return date ? new Intl.DateTimeFormat('ro-RO', { timeZone: 'UTC', ...options }).format(date) : 'Fără dată înregistrată';
}

function ownerFor(task: ProjectRecord, workspace: ProjectWorkspace) {
  const assignment = workspace.assignments.find((item) => item.record_id === task.id);
  const id = task.owner_id || assignment?.member_id;
  if (id) return workspace.members.find((member) => member.id === id) || null;
  const ownerName = normalize(task.owner);
  return ownerName ? workspace.members.find((member) => normalize(member.title) === ownerName) || null : null;
}

function ownerLabel(task: ProjectRecord) { return task.owner || 'Responsabil neînregistrat'; }

function taskDeadline(task: ProjectRecord) {
  if (task.due) return { date: task.due, label: task.due_basis === 'baseline' ? 'Termen de bază' : 'Termen raportat' };
  if (task.current_forecast) return { date: task.current_forecast, label: 'Prognoză curentă' };
  if (task.baseline_due) return { date: task.baseline_due, label: 'Termen de bază' };
  return null;
}

function scenarioFor(output: SimulationOutput | null): SimulationResult | null {
  if (!output) return null;
  return output.kind === 'simulation_comparison' ? output.scenario : output;
}

function avatarCrop(member: ProjectRecord) {
  let crop = member.avatar_crop || 'top-left';
  if (member.avatar_is_illustrative && crop === 'bottom-left') crop = 'bottom-right';
  else if (member.avatar_is_illustrative && crop === 'bottom-right') crop = 'bottom-left';
  return ({ 'top-left': '0% 0%', 'top-right': '100% 0%', 'bottom-left': '0% 100%', 'bottom-right': '100% 100%' } as const)[crop];
}

function Avatar({ member, size = 38 }: { member: ProjectRecord | null; size?: number }) {
  const initials = member?.title?.split(/\s+/).map((part) => part[0]).slice(0, 2).join('').toLocaleUpperCase() || '?';
  const style = member?.avatar_asset ? { width: size, height: size, backgroundImage: `url(${member.avatar_asset})`, backgroundPosition: avatarCrop(member) } : { width: size, height: size };
  return <span className={`tw-avatar${member?.avatar_asset ? ' tw-avatar-photo' : ''}`} style={style} aria-label={member?.avatar_is_illustrative ? `Portret ilustrativ pentru ${member.title}` : member?.title || 'Responsabil neînregistrat'}>{member?.avatar_asset ? null : initials}</span>;
}

function refsForField(record: ProjectRecord, field: string) {
  return record.field_refs?.[field] || record.source_refs || [];
}

function EvidenceLinks({ refs, workspace, onOpenSource }: { refs: SourceRef[]; workspace: ProjectWorkspace; onOpenSource: (ref: SourceRef) => void }) {
  const seen = new Set<string>();
  const unique = refs.filter((ref) => {
    const key = `${ref.source_id}\u0000${ref.location}\u0000${ref.quote}`;
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
  return <div className="tw-evidence-links">{unique.length ? unique.slice(0, 3).map((ref, index) => {
    const source = workspace.sources.find((item) => item.id === ref.source_id);
    return source ? <button key={`${source.id}-${index}`} type="button" onClick={() => onOpenSource(ref)}><FileText size={14} /><span>{source.name}<small>{ref.location || 'Locație neînregistrată'}</small></span><ArrowUpRight size={13} /></button> : null;
  }) : <span className="tw-unknown">Sursa nu este înregistrată.</span>}</div>;
}

function RelationKind(taskA: ProjectRecord, taskB: ProjectRecord): GroupedRelation['kind'] {
  const titles = `${taskA.title} ${taskB.title}`;
  if (/approval|aprob/i.test(titles)) return 'approval';
  if (/review|revizu|verif|validat|inspect/i.test(titles)) return 'review';
  if (/pred[aă]|handoff|transmit|livreaz|trimite|expedi/i.test(titles)) return 'handoff';
  return 'unknown';
}

function memberRelations(workspace: ProjectWorkspace, selectedId: string): GroupedRelation[] {
  const records = [...workspace.tasks, ...workspace.deliverables];
  const byId = new Map(records.map((record) => [record.id, record]));
  const dependencies = new Map<string, { prerequisite: ProjectRecord; dependent: ProjectRecord; refs: SourceRef[] }>();
  for (const dependency of workspace.dependencies) {
    const dependent = byId.get(dependency.from_id);
    const prerequisite = byId.get(dependency.to_id);
    if (dependent && prerequisite) dependencies.set(`${dependent.id}\u0000${prerequisite.id}`, { prerequisite, dependent, refs: dependency.source_refs || [] });
  }
  for (const dependent of records) for (const prerequisiteId of dependent.depends_on || []) {
    const prerequisite = byId.get(prerequisiteId);
    if (!prerequisite) continue;
    const key = `${dependent.id}\u0000${prerequisite.id}`;
    if (!dependencies.has(key)) dependencies.set(key, { prerequisite, dependent, refs: dependent.dependency_refs?.[prerequisite.id] || [] });
  }
  const grouped = new Map<string, GroupedRelation>();
  for (const dependency of dependencies.values()) {
    const from = ownerFor(dependency.prerequisite, workspace);
    const to = ownerFor(dependency.dependent, workspace);
    if (!from || !to || from.id === to.id || (from.id !== selectedId && to.id !== selectedId)) continue;
    const direction = from.id === selectedId ? 'outgoing' : 'incoming';
    const otherId = direction === 'outgoing' ? to.id : from.id;
    const kind = RelationKind(dependency.prerequisite, dependency.dependent);
    const key = `${otherId}\u0000${direction}\u0000${kind}`;
    const group = grouped.get(key) || { otherId, direction, kind, tasks: [], refs: [] };
    if (!group.tasks.some((task) => task.id === dependency.dependent.id)) group.tasks.push(dependency.dependent);
    for (const ref of dependency.refs) if (!group.refs.some((item) => item.source_id === ref.source_id && item.location === ref.location && item.quote === ref.quote)) group.refs.push(ref);
    grouped.set(key, group);
  }
  return [...grouped.values()];
}

function RelationTag({ kind }: { kind: GroupedRelation['kind'] }) {
  const label = kind === 'approval' ? 'Aprobare' : kind === 'review' ? 'Revizuire' : kind === 'handoff' ? 'Predare' : 'Dependență';
  return <span className={`tw-relation-tag tw-relation-${kind}`}>{label}</span>;
}

function CollaborationSummary({ member, workspace }: { member: ProjectRecord; workspace: ProjectWorkspace }) {
  const profile = member.collaboration_profile || null;
  const compatibility = profile?.compatibility || [];
  const skills = profile?.soft_skills || [];
  return <div className="tw-collaboration-summary">
    <div className="tw-profile-section-title"><h3>Colaborare declarată</h3><span className={`tw-evidence-pill ${profile ? 'is-known' : 'is-unknown'}`}>{profile ? (profile.basis === 'provided_assessment' ? 'Evaluare furnizată' : 'Declarat') : 'Necunoscut'}</span></div>
    {profile ? <>
      <p className="tw-collaboration-source"><ShieldCheck size={15} />{profile.source_label}{profile.recorded_on ? ` · ${formatDate(profile.recorded_on)}` : ' · dată neînregistrată'}</p>
      {skills.length ? <div className="tw-profile-field"><strong>Puncte forte</strong><div className="tw-skill-tags">{skills.map((skill) => <span key={skill}>{skill}</span>)}</div></div> : <div className="tw-profile-field"><strong>Puncte forte</strong><span className="tw-unknown">Neînregistrate</span></div>}
      <div className="tw-profile-field"><strong>Preferințe de lucru</strong><p>{profile.working_preferences || 'Neînregistrate'}</p></div>
      {profile.psychometric_summary && <div className="tw-assessment-note"><strong>Rezumatul evaluării furnizate</strong><p>{profile.psychometric_summary}</p><small>Metodă: {profile.psychometric_method}</small></div>}
      <div className="tw-profile-field"><strong>Note de colaborare</strong>{compatibility.length ? <div className="tw-compatibility-list">{compatibility.map((item) => {
        const colleague = workspace.members.find((candidate) => candidate.id === item.member_id);
        return <div key={item.member_id}><Avatar member={colleague || null} size={34} /><span><strong>{colleague?.title || 'Membru indisponibil'}</strong><small>{item.note}</small></span></div>;
      })}</div> : <span className="tw-unknown">Nu există note de compatibilitate înregistrate.</span>}</div>
      <p className="tw-soft-note">Aceste note sunt declarații sau evaluări furnizate. Nu se calculează automat compatibilitatea.</p>
    </> : <div className="tw-unknown-panel"><CircleHelp size={17} /><span>Nu există încă o declarație sau o evaluare de colaborare pentru această persoană.</span></div>}
  </div>;
}

function MemberProfileEditor({ member, workspace, onCancel, onSave }: { member: ProjectRecord; workspace: ProjectWorkspace; onCancel: () => void; onSave: (fields: Record<string, unknown>) => Promise<void> }) {
  const current = member.collaboration_profile;
  const [role, setRole] = useState(member.role || '');
  const [skills, setSkills] = useState((member.documented_skills || []).join('\n'));
  const [availability, setAvailability] = useState(member.availability_note || '');
  const [basis, setBasis] = useState<CollaborationProfile['basis']>(current?.basis || 'declared');
  const [sourceLabel, setSourceLabel] = useState(current?.source_label || '');
  const [recordedOn, setRecordedOn] = useState(current?.recorded_on || '');
  const [softSkills, setSoftSkills] = useState((current?.soft_skills || []).join('\n'));
  const [preferences, setPreferences] = useState(current?.working_preferences || '');
  const [psychometricMethod, setPsychometricMethod] = useState(current?.psychometric_method || '');
  const [psychometricSummary, setPsychometricSummary] = useState(current?.psychometric_summary || '');
  const [compatibility, setCompatibility] = useState<CollaborationProfile['compatibility']>(current?.compatibility || []);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const otherMembers = workspace.members.filter((candidate) => candidate.id !== member.id);
  const split = (value: string, limit: number) => value.split(/[\n,;]+/).map((item) => item.trim()).filter(Boolean).slice(0, limit);
  const profile: CollaborationProfile = {
    basis,
    source_label: sourceLabel.trim(),
    recorded_on: recordedOn || null,
    soft_skills: split(softSkills, 16),
    working_preferences: preferences.trim(),
    psychometric_method: basis === 'provided_assessment' && psychometricMethod.trim() ? psychometricMethod.trim() : null,
    psychometric_summary: basis === 'provided_assessment' && psychometricSummary.trim() ? psychometricSummary.trim() : null,
    compatibility: compatibility.map((item) => ({ member_id: item.member_id, note: item.note.trim() })),
  };
  const profileHasData = basis !== 'declared' || Boolean(profile.source_label || profile.recorded_on || profile.soft_skills.length || profile.working_preferences || profile.psychometric_method || profile.psychometric_summary || profile.compatibility.length);
  const currentProfile = member.collaboration_profile || null;
  const currentProfileKey = currentProfile ? JSON.stringify({ basis: currentProfile.basis, source_label: currentProfile.source_label.trim(), recorded_on: currentProfile.recorded_on || null, soft_skills: (currentProfile.soft_skills || []).map((item) => item.trim()).filter(Boolean), working_preferences: (currentProfile.working_preferences || '').trim(), psychometric_method: currentProfile.psychometric_method?.trim() || null, psychometric_summary: currentProfile.psychometric_summary?.trim() || null, compatibility: (currentProfile.compatibility || []).map((item) => ({ member_id: item.member_id, note: item.note.trim() })) }) : null;
  const nextProfileKey = JSON.stringify({ ...profile, compatibility: profile.compatibility.map((item) => ({ member_id: item.member_id, note: item.note })) });
  const profileChanged = currentProfile ? currentProfileKey !== nextProfileKey : profileHasData;
  const skillsValue = split(skills, 16);
  const nextAvailability = availability.trim() || null;

  const save = async (event: React.FormEvent) => {
    event.preventDefault(); setBusy(true); setError('');
    if (profileChanged && sourceLabel.trim().length < 3) { setError('Adaugă o etichetă pentru sursa declarației sau evaluării.'); setBusy(false); return; }
    if (profileChanged && compatibility.some((item) => !item.member_id || item.note.trim().length < 3)) { setError('Completează membrul și nota pentru fiecare relație sau elimină rândul incomplet.'); setBusy(false); return; }
    if (profileChanged && new Set(compatibility.map((item) => item.member_id)).size !== compatibility.length) { setError('Alege un singur rând pentru fiecare coleg.'); setBusy(false); return; }
    if (profileChanged && profile.psychometric_summary && !profile.psychometric_method) { setError('Rezumatul psihometric necesită metoda evaluării furnizate.'); setBusy(false); return; }
    if (profileChanged && profile.compatibility.some((item) => !otherMembers.some((candidate) => candidate.id === item.member_id))) { setError('Alege un alt membru din proiect pentru fiecare notă.'); setBusy(false); return; }
    if (!reason.trim()) { setError('Scrie motivul pentru această modificare.'); setBusy(false); return; }
    const fields: Record<string, unknown> = { reason: reason.trim() };
    if ((role.trim() || null) !== (member.role || null)) fields.role = role.trim() || null;
    if (JSON.stringify(skillsValue) !== JSON.stringify(member.documented_skills || [])) fields.documented_skills = skillsValue;
    if (nextAvailability !== (member.availability_note || null)) fields.availability_note = nextAvailability;
    if (profileChanged) fields.collaboration_profile = profile;
    if (Object.keys(fields).length === 1) { setError('Nu ai schimbat câmpuri de profil.'); setBusy(false); return; }
    try {
      await onSave(fields);
      onCancel();
    } catch (reason: any) { setError(reason?.message || 'Nu am putut salva profilul.'); }
    finally { setBusy(false); }
  };

  return <form className="tw-profile-editor" onSubmit={save}>
    <div className="tw-profile-editor-heading"><div><strong>Editează profilul</strong><small>Note furnizate explicit, cu sursa și motivul modificării.</small></div><button type="button" className="tw-icon-button" onClick={onCancel} aria-label="Închide editarea"><X size={17} /></button></div>
    <label className="tw-field">Rol în proiect<input value={role} onChange={(event) => setRole(event.target.value)} placeholder="Rol consemnat" /></label>
    <label className="tw-field">Competențe documentate<textarea rows={3} value={skills} onChange={(event) => setSkills(event.target.value)} placeholder="O competență pe rând" /></label>
    <label className="tw-field">Disponibilitate din sursă<textarea rows={2} value={availability} onChange={(event) => setAvailability(event.target.value)} placeholder="Notă exactă sau lasă necompletat dacă nu este cunoscută" /></label>
    <div className="tw-editor-divider" />
    <label className="tw-field">Baza profilului<select value={basis} onChange={(event) => setBasis(event.target.value as CollaborationProfile['basis'])}><option value="declared">Declarat</option><option value="provided_assessment">Evaluare furnizată</option></select></label>
    <label className="tw-field">Sursa declarației sau evaluării<input value={sourceLabel} onChange={(event) => setSourceLabel(event.target.value)} placeholder="Ex. fișa de rol, notă de manager, raport furnizat" required={profileChanged} /></label>
    <label className="tw-field">Data consemnării<input type="date" value={recordedOn} onChange={(event) => setRecordedOn(event.target.value)} /></label>
    <label className="tw-field">Puncte forte / soft skills<textarea rows={3} value={softSkills} onChange={(event) => setSoftSkills(event.target.value)} placeholder="Numai atribute declarate sau din evaluarea furnizată" /></label>
    <label className="tw-field">Preferințe de lucru<textarea rows={3} value={preferences} onChange={(event) => setPreferences(event.target.value)} /></label>
    {basis === 'provided_assessment' && <>
      <label className="tw-field">Metoda evaluării, dacă include rezumat psihometric<input value={psychometricMethod} onChange={(event) => setPsychometricMethod(event.target.value)} placeholder="Eticheta metodei furnizate" /></label>
      <label className="tw-field">Rezumat psihometric furnizat<textarea rows={3} value={psychometricSummary} onChange={(event) => setPsychometricSummary(event.target.value)} placeholder="Nu deducem acest rezumat din CV sau fotografie" /></label>
    </>}
    <div className="tw-profile-field"><div className="tw-profile-section-title"><strong>Note de colaborare între membri</strong><button type="button" className="tw-link-button" onClick={() => setCompatibility((items) => [...items, { member_id: '', note: '' }])} disabled={compatibility.length >= 30}><Plus size={14} /> Adaugă notă</button></div>
      {compatibility.map((item, index) => <div className="tw-compatibility-edit-row" key={`${item.member_id}-${index}`}><select value={item.member_id} onChange={(event) => setCompatibility((items) => items.map((candidate, candidateIndex) => candidateIndex === index ? { ...candidate, member_id: event.target.value } : candidate))}><option value="">Alege un coleg</option>{otherMembers.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.title}</option>)}</select><textarea rows={2} value={item.note} onChange={(event) => setCompatibility((items) => items.map((candidate, candidateIndex) => candidateIndex === index ? { ...candidate, note: event.target.value } : candidate))} placeholder="Notă furnizată, fără scor automat" /><button type="button" className="tw-icon-button" aria-label="Elimină nota" onClick={() => setCompatibility((items) => items.filter((_, candidateIndex) => candidateIndex !== index))}><X size={15} /></button></div>)}
      {!compatibility.length && <p className="tw-unknown">Nu există note de colaborare înregistrate.</p>}
    </div>
    <label className="tw-field">Motivul modificării<input value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Ex. actualizare din fișa de rol" required /></label>
    {error && <p className="tw-form-error" role="alert">{error}</p>}
    <div className="tw-form-actions"><button type="button" className="tw-secondary-button" onClick={onCancel} disabled={busy}>Anulează</button><button type="submit" className="tw-primary-button" disabled={busy}>{busy ? <LoaderCircle size={16} className="tw-spin" /> : <Check size={16} />} Salvează cu motiv</button></div>
  </form>;
}

function MemberInspector({ member, workspace, panel, setPanel, onSelectTask, onOpenSource, onSave, inspectorRef }: { member: ProjectRecord; workspace: ProjectWorkspace; panel: MemberPanel; setPanel: (panel: MemberPanel) => void; onSelectTask: (id: string) => void; onOpenSource: (ref: SourceRef) => void; onSave: (kind: string, id: string, fields: Record<string, unknown>) => Promise<void>; inspectorRef: React.Ref<HTMLElement> }) {
  const [editing, setEditing] = useState(false);
  const assigned = [...workspace.tasks, ...workspace.deliverables].filter((task) => ownerFor(task, workspace)?.id === member.id);
  const explicitSkills = member.documented_skills || [];
  const related = memberRelations(workspace, member.id);
  const plannedHours = assigned.reduce((sum, task) => sum + (Number.isFinite(task.effort_hours) ? Number(task.effort_hours) : 0), 0);
  const evidencedHoursCount = assigned.filter((task) => Number.isFinite(task.effort_hours)).length;
  const saveProfile = (fields: Record<string, unknown>) => onSave('member', member.id, fields);
  const profileRefs = [...refsForField(member, 'role'), ...refsForField(member, 'documented_skills'), ...refsForField(member, 'availability_note')];
  const titleRefs = refsForField(member, 'title');
  const workButton = (task: ProjectRecord) => <button type="button" className="tw-member-task-row" key={task.id} onClick={() => onSelectTask(task.id)}><span className="tw-task-row-title"><strong>{task.title}</strong><small>{statusLabel(task.status)} · {task.due ? formatDate(task.due) : 'Fără termen consemnat'}</small></span><span className="tw-task-row-duration">{task.effort_hours != null ? `${task.effort_hours} h efort` : 'Efort necunoscut'}</span><ChevronRight size={15} /></button>;

  return <aside ref={inspectorRef} className="tw-inspector" aria-label={`Profil ${member.title}`}>
    <header className="tw-inspector-person"><Avatar member={member} size={74} /><div><h2>{member.title}</h2><p>{member.role || 'Rol neînregistrat'}</p><span className="tw-evidence-pill">{member.member_type === 'person' ? 'Membru' : statusLabel(member.member_type)}</span></div><button type="button" className="tw-icon-button" aria-label="Editează profilul" onClick={() => setEditing((value) => !value)}><Settings2 size={17} /></button></header>
    <nav className="tw-profile-tabs" aria-label="Detalii membru">{([{ id: 'profile', label: 'Profil' }, { id: 'tasks', label: 'Sarcini' }, { id: 'relations', label: 'Relații' }] as const).map((item) => <button key={item.id} type="button" className={panel === item.id ? 'is-active' : ''} aria-pressed={panel === item.id} onClick={() => { setEditing(false); setPanel(item.id); }}>{item.label}{item.id === 'tasks' ? ` (${assigned.length})` : item.id === 'relations' ? ` (${related.length})` : ''}</button>)}</nav>
    {editing ? <MemberProfileEditor key={member.id} member={member} workspace={workspace} onCancel={() => setEditing(false)} onSave={saveProfile} /> : <>
      {panel === 'profile' && <div className="tw-inspector-body">
        <div className="tw-profile-metrics"><div><span>Sarcini alocate</span><strong>{assigned.length}</strong></div><div><span>Efort planificat consemnat</span><strong>{evidencedHoursCount ? `${plannedHours} h` : 'Necunoscut'}</strong><small>Nu reprezintă disponibilitatea</small></div></div>
        <section className="tw-profile-field"><div className="tw-profile-section-title"><h3>Competențe documentate</h3>{explicitSkills.length > 0 && <span className="tw-evidence-pill is-known">Din sursă</span>}</div>{explicitSkills.length ? <div className="tw-skill-tags">{explicitSkills.map((skill) => <span key={skill}>{skill}</span>)}</div> : <p className="tw-unknown">Necunoscute</p>}<EvidenceLinks refs={member.field_refs?.documented_skills || member.source_refs || []} workspace={workspace} onOpenSource={onOpenSource} /></section>
        <section className="tw-profile-field"><div className="tw-profile-section-title"><h3>Disponibilitate</h3><span className={`tw-evidence-pill ${member.availability_note ? 'is-known' : 'is-unknown'}`}>{member.availability_note ? 'Din sursă' : 'Necunoscută'}</span></div><p className={member.availability_note ? '' : 'tw-unknown'}>{member.availability_note || 'Nu este consemnată.'}</p><small>Fără conversie automată în ore sau capacitate.</small><EvidenceLinks refs={member.field_refs?.availability_note || []} workspace={workspace} onOpenSource={onOpenSource} /></section>
        <CollaborationSummary member={member} workspace={workspace} />
        <section className="tw-profile-field"><div className="tw-profile-section-title"><h3>Rol în proiect</h3></div><p>{member.role || 'Neînregistrat'}</p><EvidenceLinks refs={member.field_refs?.role || member.source_refs || []} workspace={workspace} onOpenSource={onOpenSource} /></section>
        {member.description && <section className="tw-profile-field"><h3>Descriere</h3><p>{member.description}</p><EvidenceLinks refs={member.field_refs?.description || []} workspace={workspace} onOpenSource={onOpenSource} /></section>}
        {titleRefs.length > 0 && <EvidenceLinks refs={titleRefs} workspace={workspace} onOpenSource={onOpenSource} />}
      </div>}
      {panel === 'tasks' && <div className="tw-inspector-body"><div className="tw-detail-title"><h3>Sarcini</h3><span>{assigned.length}</span></div>{assigned.length ? <div className="tw-member-task-list">{assigned.map(workButton)}</div> : <p className="tw-unknown">Nu există sarcini alocate în registru.</p>}<button type="button" className="tw-link-button" onClick={() => onSelectTask('')}>Deschide lista de sarcini <ArrowRight size={14} /></button></div>}
      {panel === 'relations' && <div className="tw-inspector-body"><div className="tw-detail-title"><h3>Relații în proiect</h3><span>{related.length}</span></div>{related.length ? <div className="tw-relations-list">{related.map((relation) => {
        const other = workspace.members.find((candidate) => candidate.id === relation.otherId);
        return <article className="tw-relation-card" key={`${relation.otherId}-${relation.direction}-${relation.kind}`}><div className="tw-relation-person"><Avatar member={other || null} size={42} /><span><strong>{other?.title || 'Membru necunoscut'}</strong><small>{other?.role || 'Rol neînregistrat'}</small></span><RelationTag kind={relation.kind} /></div><p>{relation.direction === 'outgoing' ? 'Are sarcini care preced lucrul acestei persoane.' : 'Are sarcini dependente de lucrul acestei persoane.'}</p><div className="tw-relation-tasks">{relation.tasks.map((task) => <button type="button" key={task.id} onClick={() => onSelectTask(task.id)}>{task.title}<ChevronRight size={14} /></button>)}</div><EvidenceLinks refs={relation.refs} workspace={workspace} onOpenSource={onOpenSource} /></article>;
      })}</div> : <p className="tw-unknown">Nu există dependențe documentate între această persoană și alt responsabil.</p>}<p className="tw-soft-note">Tipul relației folosește titlul sarcinii. Nu reprezintă o măsurare a compatibilității.</p></div>}
    </>}
  </aside>;
}

function TaskFilter({ statusFilter, setStatusFilter }: { statusFilter: string; setStatusFilter: (value: string) => void }) {
  return <label className="tw-filter-select"><Filter size={15} /><span className="tw-sr-only">Filtrează după stare</span><select aria-label="Filtrează după stare" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}><option value="all">Toate stările</option><option value="planned">De început</option><option value="active">În lucru</option><option value="review">În revizuire</option><option value="waiting">În așteptare</option><option value="done">Finalizat</option></select><ChevronDown size={14} /></label>;
}

function TaskListView({ tasks, workspace, selectedTaskId, onSelect }: { tasks: ProjectRecord[]; workspace: ProjectWorkspace; selectedTaskId: string | null; onSelect: (id: string) => void }) {
  return <div className="tw-task-list-view"><div className="tw-task-list-header"><span>#</span><span>Sarcină</span><span>Responsabil</span><span>Termen</span><span>Stare</span><span /></div>{tasks.map((task, index) => {
    const owner = ownerFor(task, workspace); const deadline = taskDeadline(task);
    return <button type="button" key={task.id} className={`tw-task-list-row${task.id === selectedTaskId ? ' is-selected' : ''}`} onClick={() => onSelect(task.id)}><span className="tw-task-index">{String(index + 1).padStart(2, '0')}</span><span className="tw-task-row-title"><strong>{task.title}</strong><small>{task.planned_duration_days != null ? `Durată · ${task.planned_duration_days} zile` : 'Durată necunoscută'}{task.effort_hours != null ? ` · Efort · ${task.effort_hours} h` : ''}</small></span><span className="tw-task-owner"><Avatar member={owner} size={34} />{owner?.title || ownerLabel(task)}</span><span className="tw-task-deadline">{deadline ? <><strong>{formatDate(deadline.date)}</strong><small>{deadline.label}</small></> : 'Necunoscut'}</span><span><StatusPill status={task.status} /></span><ChevronRight size={16} /></button>;
  })}{!tasks.length && <div className="tw-empty-state">Nu există sarcini care corespund căutării și filtrului.</div>}</div>;
}

function StatusPill({ status }: { status?: string | null }) {
  const bucket = status ? taskBucket({ status, completed_at: null } as ProjectRecord) : 'planned';
  return <span className={`tw-status-pill tw-status-${bucket}`}>{statusLabel(status)}</span>;
}

function GanttView({ tasks, workspace, selectedTaskId, onSelect, simulationOutput }: { tasks: ProjectRecord[]; workspace: ProjectWorkspace; selectedTaskId: string | null; onSelect: (id: string) => void; simulationOutput: SimulationOutput | null }) {
  const simulation = scenarioFor(simulationOutput);
  const modeledDates = (simulation?.tasks || []).flatMap((item) => {
    try { return [{ taskId: item.taskId, date: workingDateAtOffset(simulation!.config.calendar, item.finishDays.p50) }]; }
    catch { return []; }
  });
  const modelDateById = new Map(modeledDates.map((item) => [item.taskId, item.date]));
  const dates = [...tasks.flatMap((task) => [task.planned_start, taskDeadline(task)?.date].filter((value): value is string => Boolean(validDate(value)))), ...modeledDates.map((item) => item.date)];
  const timestamps = dates.map((value) => validDate(value)!.getTime());
  const minTime = timestamps.length ? Math.min(...timestamps) : 0;
  const maxTime = timestamps.length ? Math.max(...timestamps) : 0;
  const sameDay = timestamps.length && maxTime === minTime;
  const axisStart = timestamps.length ? minTime - (sameDay ? 86400000 : 0) : 0;
  const axisEnd = timestamps.length ? maxTime + (sameDay ? 86400000 : 0) : 0;
  const span = Math.max(86400000, axisEnd - axisStart);
  const x = (value?: string | null) => {
    const date = validDate(value); return date ? Math.max(0, Math.min(100, (date.getTime() - axisStart) / span * 100)) : null;
  };
  const ticks: Date[] = [];
  if (timestamps.length) {
    const start = new Date(axisStart); start.setUTCHours(0, 0, 0, 0);
    const days = Math.max(1, Math.ceil(span / 86400000));
    const step = days <= 12 ? 1 : days <= 24 ? 3 : days <= 50 ? 7 : days <= 100 ? 14 : 30;
    for (let offset = 0; offset <= days; offset += step) ticks.push(new Date(start.getTime() + offset * 86400000));
    const end = new Date(axisEnd); if (!ticks.some((tick) => tick.getTime() === end.getTime())) ticks.push(end);
  }
  const rowHeight = 66;
  const indexById = new Map(tasks.map((task, index) => [task.id, index]));
  const now = new Date(); now.setUTCHours(0, 0, 0, 0);
  const todayX = x(now.toISOString().slice(0, 10));
  const dependencyLines = tasks.flatMap((task, toIndex) => (task.depends_on || []).flatMap((id) => {
    const fromIndex = indexById.get(id); const prerequisite = workspace.tasks.find((item) => item.id === id) || workspace.deliverables.find((item) => item.id === id);
    if (fromIndex == null || !prerequisite) return [];
    const fromDate = taskDeadline(prerequisite)?.date || prerequisite.planned_start;
    const toDate = task.planned_start || taskDeadline(task)?.date;
    const fromX = x(fromDate); const toX = x(toDate);
    if (fromX == null || toX == null) return [];
    return [{ key: `${id}-${task.id}`, fromX, toX, fromY: fromIndex * rowHeight + rowHeight / 2, toY: toIndex * rowHeight + rowHeight / 2, title: `${prerequisite.title} → ${task.title}` }];
  }));
  const formatTick = (date: Date) => new Intl.DateTimeFormat('ro-RO', { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(date);
  const monthLabels = ticks.filter((tick, index) => index === 0 || tick.getUTCMonth() !== ticks[index - 1].getUTCMonth());
  return <section className="tw-gantt" aria-label="Gantt cu termene și dependențe consemnate">
    <div className="tw-gantt-grid">
      <div className="tw-gantt-head"><span>Sarcină</span><span>Responsabil</span><span>Termen</span><div className="tw-gantt-timeline-head"><div className="tw-gantt-months">{monthLabels.map((date) => <span key={`${date.getUTCFullYear()}-${date.getUTCMonth()}`} style={{ left: `${x(date.toISOString().slice(0, 10)) ?? 0}%` }}>{new Intl.DateTimeFormat('ro-RO', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(date)}</span>)}</div><div className="tw-gantt-ticks">{ticks.map((date, index) => <span key={`${date.toISOString()}-${index}`} style={{ left: `${x(date.toISOString().slice(0, 10)) ?? 0}%` }}>{formatTick(date)}</span>)}</div></div></div>
      <div className="tw-gantt-body"><div className="tw-gantt-lines" aria-hidden="true"><svg viewBox={`0 0 1000 ${Math.max(1, tasks.length * rowHeight)}`} preserveAspectRatio="none"><defs><marker id="tw-gantt-arrow" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto"><path d="M0,0 L7,3.5 L0,7 z" fill="#98a6b5" /></marker></defs>{dependencyLines.map((line) => <path key={line.key} d={`M ${line.fromX * 10} ${line.fromY} C ${line.fromX * 10 + 24} ${line.fromY}, ${line.toX * 10 - 24} ${line.toY}, ${line.toX * 10} ${line.toY}`} markerEnd="url(#tw-gantt-arrow)"><title>{line.title}</title></path>)}</svg></div>
        {tasks.map((task) => {
          const owner = ownerFor(task, workspace); const deadline = taskDeadline(task);
          const startValue = task.planned_start || deadline?.date;
          const startX = x(startValue); const endX = x(deadline?.date || null);
          const modelDate = modelDateById.get(task.id) || null; const modelX = x(modelDate);
          const hasInterval = Boolean(task.planned_start && deadline && startX != null && endX != null && endX > startX);
          const milestone = !hasInterval ? startX ?? endX : null;
          return <div key={task.id} className={`tw-gantt-row${task.id === selectedTaskId ? ' is-selected' : ''}`}>
            <button type="button" className="tw-gantt-task" onClick={() => onSelect(task.id)}><strong>{task.title}</strong><small>{task.planned_duration_days != null ? `Durată ${task.planned_duration_days} zile` : 'Durată necunoscută'}{task.effort_hours != null ? ` · Efort ${task.effort_hours} h` : ''}</small></button>
            <span className="tw-gantt-owner"><Avatar member={owner} size={32} />{owner?.title || 'Necunoscut'}</span>
            <span className="tw-gantt-date">{deadline ? <>{formatDate(deadline.date, { day: '2-digit', month: 'short' })}<small>{deadline.label}</small></> : 'Termen necunoscut'}</span>
            <div className="tw-gantt-track">{ticks.map((tick, index) => <i key={`${tick.toISOString()}-${index}`} style={{ left: `${x(tick.toISOString().slice(0, 10)) ?? 0}%` }} />)}
              {hasInterval && <span className={`tw-gantt-bar ${deadline?.label === 'Prognoză curentă' ? 'is-forecast' : ''}`} style={{ left: `${startX}%`, width: `${Math.max(0, endX! - startX!)}%` }} title={`${formatDate(task.planned_start)} → ${formatDate(deadline?.date)}`} />}
              {milestone != null && <span className={`tw-gantt-milestone ${!task.planned_start ? 'is-due' : 'is-start'}`} style={{ left: `${milestone}%` }} title={task.planned_start ? 'Început cunoscut, termen necunoscut' : deadline ? deadline.label : 'Termen necunoscut'} />}
              {modelX != null && <span className="tw-gantt-model-mark" style={{ left: `${modelX}%` }} title={`Model Monte Carlo P50 · ${formatDate(modelDate)}`} />}
              {todayX != null && todayX >= 0 && todayX <= 100 && <span className="tw-gantt-today" style={{ left: `${todayX}%` }} />}
              {!deadline && !task.planned_start && <span className="tw-gantt-unknown">Fără poziție calendaristică</span>}
            </div>
          </div>;
        })}
        {!tasks.length && <div className="tw-empty-state">Nu există sarcini în lista filtrată.</div>}
      </div>
    </div>
    <div className="tw-gantt-legend"><span><i className="tw-plan-swatch" />Interval între început și termen consemnate</span><span><i className="tw-milestone-swatch" />Un singur reper cunoscut</span>{simulation && <span><i className="tw-model-swatch" />Model Monte Carlo P50</span>}<span><i className="tw-today-swatch" />Azi</span><span>Durata și efortul apar separat sub sarcină.</span></div>
  </section>;
}

function KanbanView({ tasks, workspace, selectedTaskId, onSelect }: { tasks: ProjectRecord[]; workspace: ProjectWorkspace; selectedTaskId: string | null; onSelect: (id: string) => void }) {
  const lanes: Array<{ id: ReturnType<typeof taskBucket>; title: string }> = [
    { id: 'planned', title: 'De început' }, { id: 'active', title: 'În lucru' }, { id: 'review', title: 'În revizuire' }, { id: 'waiting', title: 'În așteptare' }, { id: 'done', title: 'Finalizat' },
  ];
  return <div className="tw-kanban">{lanes.map((lane) => {
    const items = tasks.filter((task) => taskBucket(task) === lane.id);
    return <section className={`tw-kanban-lane tw-lane-${lane.id}`} key={lane.id}><header><strong>{lane.title}</strong><span>{items.length}</span></header>{items.map((task) => {
      const owner = ownerFor(task, workspace); const deadline = taskDeadline(task);
      return <button type="button" key={task.id} className={`tw-kanban-card${lane.id === 'waiting' ? ' is-waiting' : ''}${task.id === selectedTaskId ? ' is-selected' : ''}`} onClick={() => onSelect(task.id)}><div className="tw-kanban-card-meta"><span className="tw-kanban-dot" />{statusLabel(task.status)}</div><strong>{task.title}</strong><span className="tw-kanban-date">{deadline ? formatDate(deadline.date) : 'Termen necunoscut'}</span><span className="tw-kanban-owner"><Avatar member={owner} size={30} />{owner?.title || ownerLabel(task)}</span><span className="tw-kanban-dependencies"><GitBranch size={14} />{task.depends_on?.length ? `${task.depends_on.length} dependențe` : 'Fără dependențe consemnate'}</span></button>;
    })}{!items.length && <p className="tw-lane-empty">Fără sarcini</p>}</section>;
  })}</div>;
}

function ListSourceLinks({ task, workspace, onOpenSource }: { task: ProjectRecord; workspace: ProjectWorkspace; onOpenSource: (ref: SourceRef) => void }) {
  return <EvidenceLinks refs={task.source_refs || []} workspace={workspace} onOpenSource={onOpenSource} />;
}

function BurndownView({ tasks, workspace, simulationOutput, onSelect, onOpenSource, onOpenDecision }: { tasks: ProjectRecord[]; workspace: ProjectWorkspace; simulationOutput: SimulationOutput | null; onSelect: (id: string) => void; onOpenSource: (ref: SourceRef) => void; onOpenDecision?: (id: string) => void }) {
  const simulation = scenarioFor(simulationOutput);
  const remainingForecast: RemainingWorkForecast | null = simulation?.remainingWorkForecast || null;
  const displayedAllTasks = tasks.length === workspace.tasks.length && workspace.tasks.every((task) => tasks.some((item) => item.id === task.id));
  const simulatedTaskIds = new Set(simulation?.tasks.map((task) => task.taskId) || []);
  const filterMatchesModelScope = !simulation || displayedAllTasks;
  const chartScopeTasks = simulation ? workspace.tasks.filter((task) => simulatedTaskIds.has(task.id)) : tasks;
  const countSeriesEnabled = filterMatchesModelScope && remainingForecast?.unit !== 'hours';
  const markedComplete = chartScopeTasks.filter((task) => Boolean(task.completed_at) || isCompleted(task.status));
  const confirmedCompleted = markedComplete.filter((task) => ['manager_confirmed', 'manager_corrected'].includes(task.review_state) && Boolean(validDate(task.completed_at)));
  const completedDates = confirmedCompleted.map((task) => validDate(task.completed_at)!.toISOString().slice(0, 10));
  const completionDays = [...new Set(completedDates)].sort();
  const actualReady = countSeriesEnabled && markedComplete.length > 0 && confirmedCompleted.length === markedComplete.length && completionDays.length >= 2;
  const actualByDay = new Map<string, number>();
  for (const date of completedDates) actualByDay.set(date, (actualByDay.get(date) || 0) + 1);
  const planDates = chartScopeTasks.map((task) => taskDeadline(task)?.date || null);
  const planReady = countSeriesEnabled && chartScopeTasks.length > 0 && planDates.every(Boolean);
  const planByDay = new Map<string, number>();
  if (planReady) for (const date of planDates as string[]) planByDay.set(date.slice(0, 10), (planByDay.get(date.slice(0, 10)) || 0) + 1);

  const modelPoints = remainingForecast && simulation ? remainingForecast.points.map((point) => {
    let date = point.date;
    try { date = workingDateAtOffset(simulation.config.calendar, point.workingDays); } catch { /* Keep the date supplied with the model point. */ }
    return { ...point, date };
  }) : [];
  const modelReady = modelPoints.length > 1;
  const modelByDate = new Map(modelPoints.map((point) => [point.date, point.remaining]));
  const modelDates = [...new Set(modelPoints.map((point) => point.date))].sort();
  const days = [...new Set([...(countSeriesEnabled ? completionDays : []), ...planByDay.keys(), ...modelDates, ...(simulation?.deadlineOutlook?.deadlineDate ? [simulation.deadlineOutlook.deadlineDate] : [])])].sort();
  const cumulative = (events: Map<string, number>, day: string) => [...events.entries()].filter(([date]) => date <= day).reduce((sum, [, count]) => sum + count, 0);
  const remaining = (events: Map<string, number>, day: string) => Math.max(0, chartScopeTasks.length - cumulative(events, day));
  const series = days.map((day) => ({
    day,
    actual: actualReady && countSeriesEnabled ? remaining(actualByDay, day) : null,
    plan: planReady ? remaining(planByDay, day) : null,
    p10: modelByDate.get(day)?.p10 ?? null,
    p50: modelByDate.get(day)?.p50 ?? null,
    p90: modelByDate.get(day)?.p90 ?? null,
  }));
  const width = 900; const height = 380; const pad = { left: 58, top: 28, right: 25, bottom: 50 };
  const yMax = Math.max(1, chartScopeTasks.length, ...modelPoints.map((point) => point.remaining.p90));
  const firstDay = days[0]; const lastDay = days.at(-1);
  const firstTime = firstDay ? validDate(firstDay)?.getTime() ?? 0 : 0;
  const lastTime = lastDay ? validDate(lastDay)?.getTime() ?? firstTime : firstTime;
  const xAt = (day: string) => pad.left + (lastTime === firstTime ? 0 : ((validDate(day)?.getTime() ?? firstTime) - firstTime) / (lastTime - firstTime)) * (width - pad.left - pad.right);
  const yAt = (value: number) => height - pad.bottom - (value / yMax) * (height - pad.top - pad.bottom);
  const pathFor = (key: 'actual' | 'plan' | 'p10' | 'p50' | 'p90') => {
    const points = series.map((point) => ({ x: xAt(point.day), y: point[key] == null ? null : yAt(point[key]!) })).filter((point): point is { x: number; y: number } => point.y != null);
    if (!points.length) return '';
    if (key === 'p10' || key === 'p50' || key === 'p90') return points.map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x} ${point.y}`).join(' ');
    return points.map((point, index) => index === 0 ? `M ${point.x} ${point.y}` : `H ${point.x} V ${point.y}`).join(' ');
  };
  const risk = simulation?.deadlineOutlook || null;
  const forecastLabel = simulationOutput?.kind === 'simulation_comparison' ? `Scenariu: ${simulationOutput.intervention.label}` : 'Rulare curentă';
  const lateShare = risk ? risk.lateUpTo7Days.share + risk.lateMoreThan7Days.share : null;
  const riskFactor = simulation?.tasks.slice().sort((a, b) => b.finishDays.p90 - a.finishDays.p90)[0];
  const riskTask = riskFactor ? workspace.tasks.find((task) => task.id === riskFactor.taskId) : null;
  const riskDecision = riskTask && workspace.decisions.find((decision) => decision.depends_on?.includes(riskTask.id));
  let riskFinishDate: string | null = null;
  if (simulation && riskFactor) { try { riskFinishDate = workingDateAtOffset(simulation.config.calendar, riskFactor.finishDays.p90); } catch { riskFinishDate = null; } }
  const tickIndexes = series.map((_, index) => index).filter((index) => index === 0 || index === series.length - 1 || index % Math.max(1, Math.ceil(series.length / 7)) === 0);
  const workUnitLabel = remainingForecast?.unit === 'hours' ? 'ore de efort planificat' : 'sarcini';
  return <div className="tw-burndown-page">
    <div className="tw-burndown-grid">
      <section className="tw-burndown-chart-card">
        <header><div><h2>{remainingForecast?.unit === 'hours' ? 'Efort planificat rămas' : 'Sarcini rămase'}</h2><p>{firstDay && lastDay ? `${formatDate(firstDay, { day: 'numeric', month: 'long' })} – ${formatDate(lastDay, { day: 'numeric', month: 'long', year: 'numeric' })} · ${workUnitLabel}` : 'Perioada apare după înregistrarea termenelor sau finalizărilor'}</p></div><div className="tw-chart-legend">{actualReady && <span><i className="tw-actual-line" />Finalizări confirmate</span>}{planReady && <span><i className="tw-plan-line" />Plan la termenele consemnate</span>}{modelReady && <span><i className="tw-model-line" />Model P50 · {remainingForecast?.unit === 'hours' ? 'ore' : 'sarcini'}</span>}{modelReady && <span><i className="tw-model-range" />Model P10–P90</span>}</div></header>
        {days.length > 1 ? <div className="tw-chart-scroll"><svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Istoric confirmat și forecast Monte Carlo afișate separat">
          {[0, .25, .5, .75, 1].map((fraction) => { const value = Math.round(yMax * fraction); return <g key={fraction}><line className="tw-chart-gridline" x1={pad.left} x2={width - pad.right} y1={yAt(value)} y2={yAt(value)} /><text className="tw-chart-axis-label" x={pad.left - 12} y={yAt(value) + 4} textAnchor="end">{value}</text></g>; })}
          {series.some((point) => point.p10 != null && point.p90 != null) && <path className="tw-chart-model-band" d={`${series.filter((point) => point.p90 != null).map((point, index) => `${index === 0 ? 'M' : 'L'} ${xAt(point.day)} ${yAt(point.p90!)}`).join(' ')} ${series.filter((point) => point.p10 != null).slice().reverse().map((point) => `L ${xAt(point.day)} ${yAt(point.p10!)}`).join(' ')} Z`} />}
          {series.some((point) => point.plan != null) && <path className="tw-chart-plan" d={pathFor('plan')} />}
          {series.some((point) => point.p10 != null) && <path className="tw-chart-model-edge" d={pathFor('p10')} />}
          {series.some((point) => point.p90 != null) && <path className="tw-chart-model-edge" d={pathFor('p90')} />}
          {series.some((point) => point.p50 != null) && <path className="tw-chart-model" d={pathFor('p50')} />}
          {series.some((point) => point.actual != null) && <path className="tw-chart-actual" d={pathFor('actual')} />}
          {risk && <line className="tw-chart-deadline" x1={xAt(risk.deadlineDate)} x2={xAt(risk.deadlineDate)} y1={pad.top} y2={height - pad.bottom} />}
          {tickIndexes.map((index) => <text className="tw-chart-date-label" key={days[index]} x={xAt(days[index])} y={height - 14} textAnchor="middle">{formatDate(days[index], { day: 'numeric', month: 'short' })}</text>)}
        </svg></div> : <div className="tw-burndown-empty"><CircleHelp size={22} /><strong>Nu există suficiente date pentru o curbă.</strong><p>Actualul cere finalizări confirmate cu completed_at pe cel puțin două zile. Forecastul apare numai după o simulare cu distribuția rămasă pe tot eșantionul.</p></div>}
        {!filterMatchesModelScope && <div className="tw-series-notice"><AlertTriangle size={15} /><span>Filtrul curent schimbă lista față de scopul simulării. Curba modelului păstrează scopul de la începutul rulării; istoricul și planul nu sunt suprapuse.</span></div>}
        {remainingForecast?.unit === 'hours' && <div className="tw-series-notice"><AlertTriangle size={15} /><span>Forecastul folosește ore de efort planificat verificate. Finalizările observate numără sarcini, nu ore lucrate, de aceea nu se compară pe aceeași axă.</span></div>}
        {!actualReady && countSeriesEnabled && <div className="tw-series-notice"><AlertTriangle size={15} /><span>Actual indisponibil: {markedComplete.length ? `${confirmedCompleted.length} din ${markedComplete.length} finalizări au confirmare și timestamp; sunt necesare două zile.` : 'nu există finalizări confirmate cu timestamp pe două zile.'} Nu interpolăm pontaje sau schimbări istorice de scop.</span></div>}
         <p className="tw-chart-caveat">{remainingForecast?.unit === 'hours' ? 'Efortul de pe curbă este planificat și verificat, nu pontat. Modelul păstrează întreaga sarcină până la finalizarea eșantionată; milestone-urile sunt excluse.' : 'Istoricul reconstruiește numărul de sarcini finalizate confirmate cu completed_at la scopul curent. Schimbările istorice de scop nu sunt disponibile.'}</p>
      </section>
      <aside className="tw-burndown-summary">
        <header><h2>Risc de depășire a termenului</h2></header>
         {risk && lateShare != null ? <><strong className="tw-deadline-risk-value">{probabilityPercent(lateShare)} <small>în simulare</small></strong><p>Termen țintă: {formatDate(risk.deadlineDate)} · {risk.sampleCount.toLocaleString('ro-RO')} rulări · {forecastLabel}.</p><div className="tw-risk-buckets"><span>La timp <strong>{probabilityPercent(risk.onTime.share)}</strong></span><span>Cel mult 7 zile târziu <strong>{probabilityPercent(risk.lateUpTo7Days.share)}</strong></span><span>Peste 7 zile târziu <strong>{probabilityPercent(risk.lateMoreThan7Days.share)}</strong></span></div>
          {simulation?.completionDates && <div className="tw-summary-stat"><span>Finalizare P10–P50–P90</span><strong>{formatDate(simulation.completionDates.p10)} · {formatDate(simulation.completionDates.p50)} · {formatDate(simulation.completionDates.p90)}</strong></div>}
           {riskTask && <div className="tw-risk-factor"><span>Sarcină cu cuantila P90 cea mai târzie</span><button type="button" onClick={() => onSelect(riskTask.id)}><FileText size={16} /><span><strong>{riskTask.title}</strong><small>{formatDate(riskFinishDate)} · termen P90 al sarcinii</small></span><ChevronRight size={15} /></button><EvidenceLinks refs={riskTask.source_refs || []} workspace={workspace} onOpenSource={onOpenSource} /></div>}
          {riskTask && riskDecision && onOpenDecision && <button type="button" className="tw-secondary-button" onClick={() => onOpenDecision(riskDecision.id)}>Pregătește decizia <ArrowRight size={14} /></button>}
           <p className="tw-soft-note">Probabilitate estimată din model, nu certitudine. Data P90 cea mai târzie descrie ordonarea sarcinilor, nu o cauză dovedită. Proiecția MC este separată de finalizările observate.</p>
        </> : <><strong className="tw-deadline-risk-value is-unknown">Model indisponibil</strong><p>{simulation ? 'Termenul țintă nu este configurat în calendarul simulării.' : 'Rulează Monte Carlo cu o dată țintă pentru riscul de depășire.'}</p><p className="tw-soft-note">Finalizările observate și termenele consemnate rămân vizibile fără forecast.</p></>}
      </aside>
    </div>
    {countSeriesEnabled && !planReady && <p className="tw-burndown-plan-note">Curba de plan apare separat numai când fiecare sarcină din filtrul curent are un termen înregistrat.</p>}
  </div>;
}

function PriorityView({ tasks, workspace, selectedTaskId, onSelect, onOpenSource, onOpenDecision }: { tasks: ProjectRecord[]; workspace: ProjectWorkspace; selectedTaskId: string | null; onSelect: (id: string) => void; onOpenSource: (ref: SourceRef) => void; onOpenDecision?: (id: string) => void }) {
  const today = new Date(); today.setUTCHours(0, 0, 0, 0);
  const todayTime = today.getTime();
  const allTasks = workspace.tasks;
  const dependents = new Map<string, Set<string>>();
  for (const task of allTasks) for (const dependencyId of task.depends_on || []) { const set = dependents.get(dependencyId) || new Set<string>(); set.add(task.id); dependents.set(dependencyId, set); }
  const downstreamCount = (id: string) => {
    const seen = new Set<string>(); const queue = [...(dependents.get(id) || [])];
    while (queue.length) { const next = queue.shift()!; if (seen.has(next)) continue; seen.add(next); queue.push(...(dependents.get(next) || [])); }
    return seen.size;
  };
  const points = tasks.filter((task) => !isCompleted(task.status) && !task.completed_at).map((task) => {
    const deadline = taskDeadline(task); const date = deadline ? validDate(deadline.date) : null;
    const daysLeft = date ? Math.floor((date.getTime() - todayTime) / 86400000) : null;
    const downstream = downstreamCount(task.id);
    const urgency = daysLeft == null ? null : daysLeft < 0 ? 100 : daysLeft <= 7 ? 85 : daysLeft <= 14 ? 65 : daysLeft <= 30 ? 42 : 20;
    const impact = downstream;
    const reasons = [daysLeft == null ? 'Termen necunoscut' : daysLeft < 0 ? `Depășit cu ${Math.abs(daysLeft)} zile` : daysLeft === 0 ? 'Termen astăzi' : `Termen în ${daysLeft} zile`];
    reasons.push(downstream ? `${downstream} sarcini depind în aval` : 'Fără sarcini dependente în aval');
    return { task, daysLeft, downstream, urgency, impact, reasons, deadline };
  });
  const maxDownstream = Math.max(1, ...points.map((item) => item.downstream));
  const knownPoints = points.filter((item) => item.urgency != null).map((item) => ({ ...item, impact: item.downstream / maxDownstream * 100 }));
  const attention = [...knownPoints].sort((a, b) => ((a.daysLeft ?? 99999) - (b.daysLeft ?? 99999)) || b.downstream - a.downstream).slice(0, 5);
  const unknownDates = points.filter((item) => item.daysLeft == null);
  const labelLayout = new Map<string, { side: 'left' | 'right'; offset: number }>();
  const labelled = new Set<string>();
  for (const point of knownPoints) {
    if (labelled.has(point.task.id)) continue;
    const cluster = knownPoints.filter((candidate) => !labelled.has(candidate.task.id) && Math.abs(candidate.urgency! - point.urgency!) <= 25 && Math.abs(candidate.impact - point.impact) <= 18).sort((a, b) => a.impact - b.impact || a.urgency! - b.urgency!);
    cluster.forEach((candidate, index) => {
      const offset = point.impact > 75 ? 14 + index * 24 : point.impact < 20 ? -14 - index * 24 : (index - (cluster.length - 1) / 2) * 24;
      labelLayout.set(candidate.task.id, { side: candidate.urgency! >= 70 ? 'left' : 'right', offset });
      labelled.add(candidate.task.id);
    });
  }
  const decisionForTask = (taskId: string) => workspace.decisions.find((decision) => decision.depends_on?.includes(taskId));
  return <div className="tw-priorities">
    <section className="tw-priority-matrix-card"><header><div><h2>Urgență × sarcini dependente</h2><p>Poziția folosește termenul din registru și numărul de sarcini din aval.</p></div><div className="tw-priority-criteria"><span>Urgență: zile până la termen</span><span>Impact: dependențe în aval față de maximul afișat</span></div></header>
      <div className="tw-priority-matrix"><div className="tw-matrix-y-label">Sarcini dependente în aval</div><div className="tw-matrix-area"><div className="tw-matrix-quadrants"><span>Impact ridicat · Urgență scăzută</span><span>Impact ridicat · Urgență ridicată</span><span>Impact scăzut · Urgență scăzută</span><span>Impact scăzut · Urgență ridicată</span></div>{knownPoints.map((item) => { const placement = labelLayout.get(item.task.id) || { side: 'right' as const, offset: 0 }; return <button type="button" key={item.task.id} title={`${item.task.title}: ${item.reasons.join('; ')}`} className={`tw-matrix-point tw-matrix-${item.daysLeft! <= 7 ? 'urgent' : 'upcoming'} tw-label-${placement.side}${item.task.id === selectedTaskId ? ' is-selected' : ''}`} style={{ left: `${item.urgency}%`, bottom: `${item.impact}%`, '--tw-label-offset': `${placement.offset}px` } as React.CSSProperties} onClick={() => onSelect(item.task.id)}><i /><span>{item.task.title}</span></button>; })}<div className="tw-matrix-x-label"><span>Termen mai îndepărtat</span><strong>Urgență</strong><span>Termen apropiat sau depășit</span></div><div className="tw-matrix-y-ticks"><span>Ridicat</span><span>Scăzut</span></div></div></div>
      {unknownDates.length > 0 && <div className="tw-missing-priority-dates"><strong>Termen necunoscut</strong><span>{unknownDates.length} sarcini nu pot fi poziționate după urgență.</span><div>{unknownDates.map((item) => <button key={item.task.id} type="button" onClick={() => onSelect(item.task.id)}>{item.task.title} <ChevronRight size={14} /></button>)}</div></div>}
      <p className="tw-priority-disclaimer">Criterii vizibile: depășit / 0–7 zile / 8–14 zile / 15–30 zile / peste 30 zile; axa verticală compară numărul de sarcini descendente cu maximul din filtrul curent. Nu există scor ascuns.</p>
    </section>
     <section className="tw-attention-list"><header><h2>Ce cere atenție</h2><span>{attention.length}</span></header>{attention.length ? attention.map((item) => { const decision = decisionForTask(item.task.id); const sourceRef = item.task.source_refs?.[0]; return <article key={item.task.id}><span className={`tw-attention-dot ${item.daysLeft! < 0 || item.daysLeft! <= 7 ? 'urgent' : ''}`} /><div><button type="button" onClick={() => onSelect(item.task.id)}><strong>{item.task.title}</strong><small>{ownerLabel(item.task)} · {item.deadline ? formatDate(item.deadline.date) : 'Fără termen'}</small></button></div><p>{item.reasons.join(' · ')}</p>{decision && onOpenDecision && <button type="button" className="tw-link-button" onClick={() => onOpenDecision(decision.id)}>Vezi decizia <ArrowRight size={14} /></button>}{sourceRef && <button type="button" className="tw-link-button" onClick={() => onOpenSource(sourceRef)}>Vezi sursa <ArrowUpRight size={14} /></button>}</article>; }) : <p className="tw-unknown">Nu există sarcini active cu termen cunoscut în filtrul curent.</p>}</section>
  </div>;
}

function SelectedTaskStrip({ task, workspace, onClose, onOpenSource, onSave, onSelectDependency, onOpenDecision }: { task: ProjectRecord; workspace: ProjectWorkspace; onClose: () => void; onOpenSource: (ref: SourceRef) => void; onSave: (kind: string, id: string, fields: Record<string, unknown>) => Promise<void>; onSelectDependency: (id: string) => void; onOpenDecision?: (id: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(task.title);
  const [owner, setOwner] = useState(task.owner || '');
  const [status, setStatus] = useState(task.status || '');
  const [due, setDue] = useState((task.due || '').slice(0, 10));
  const [plannedStart, setPlannedStart] = useState((task.planned_start || '').slice(0, 10));
  const [duration, setDuration] = useState(task.planned_duration_days?.toString() || '');
  const [effort, setEffort] = useState(task.effort_hours?.toString() || '');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { setTitle(task.title); setOwner(task.owner || ''); setStatus(task.status || ''); setDue((task.due || '').slice(0, 10)); setPlannedStart((task.planned_start || '').slice(0, 10)); setDuration(task.planned_duration_days?.toString() || ''); setEffort(task.effort_hours?.toString() || ''); setEditing(false); setError(''); }, [task.id, task.updated_at]);
  const dependencies = (task.depends_on || []).map((id) => workspace.tasks.find((candidate) => candidate.id === id) || workspace.deliverables.find((candidate) => candidate.id === id)).filter((item): item is ProjectRecord => Boolean(item));
  const linkedDecision = workspace.decisions.find((decision) => decision.depends_on?.includes(task.id));
  const save = async (event: React.FormEvent) => {
    event.preventDefault(); setBusy(true); setError('');
    if (!reason.trim()) { setError('Scrie motivul modificării pentru istoricul proiectului.'); setBusy(false); return; }
    try {
      await onSave(task.kind === 'deliverable' ? 'deliverable' : 'task', task.id, { title: title.trim(), owner: owner || null, status: status || null, due: due || null, planned_start: plannedStart || null, planned_duration_days: duration ? Number(duration) : null, effort_hours: effort ? Number(effort) : null, reason: reason.trim() });
      setEditing(false); setReason('');
    } catch (reason: any) { setError(reason?.message || 'Nu am putut salva modificarea.'); }
    finally { setBusy(false); }
  };
  return <section className="tw-selected-task" aria-label={`Detalii sarcină ${task.title}`}>
    <div className="tw-selected-main"><div className="tw-selected-title"><span className={`tw-selected-mark tw-mark-${taskBucket(task)}`} /><div><small>Sarcină selectată</small><h2>{task.title}</h2><span>{statusLabel(task.status)} · {ownerLabel(task)} · {taskDeadline(task) ? formatDate(taskDeadline(task)?.date) : 'Termen necunoscut'}</span></div></div><div className="tw-selected-meta"><span><strong>Durată</strong>{task.planned_duration_days != null ? `${task.planned_duration_days} zile` : 'Necunoscută'}</span><span><strong>Efort</strong>{task.effort_hours != null ? `${task.effort_hours} h` : 'Necunoscut'}</span></div><div className="tw-selected-dependencies"><strong>Depinde de</strong>{dependencies.length ? dependencies.map((item) => <button type="button" key={item.id} onClick={() => onSelectDependency(item.id)}>{item.title} <ChevronRight size={13} /></button>) : <span>Nu sunt dependențe consemnate</span>}</div><div className="tw-selected-sources"><strong>Sursă</strong><ListSourceLinks task={task} workspace={workspace} onOpenSource={onOpenSource} /></div><div className="tw-selected-actions"><button type="button" className="tw-secondary-button" onClick={() => setEditing((value) => !value)}><Settings2 size={15} /> Editează</button>{linkedDecision && onOpenDecision && <button type="button" className="tw-primary-button" onClick={() => onOpenDecision(linkedDecision.id)}>Vezi decizia <ArrowRight size={14} /></button>}<button type="button" className="tw-close-task" aria-label="Închide detaliile sarcinii" onClick={onClose}><X size={16} /></button></div></div>
    {editing && <form className="tw-task-editor" onSubmit={save}><div className="tw-form-grid"><label className="tw-field">Titlu<input value={title} onChange={(event) => setTitle(event.target.value)} required /></label><label className="tw-field">Responsabil<select value={owner} onChange={(event) => setOwner(event.target.value)}><option value="">Necunoscut</option>{workspace.members.map((member) => <option key={member.id} value={member.title}>{member.title}</option>)}</select></label><label className="tw-field">Stare<input value={status} onChange={(event) => setStatus(event.target.value)} placeholder="Stare raportată" /></label><label className="tw-field">Termen curent<input type="date" value={due} onChange={(event) => setDue(event.target.value)} /></label><label className="tw-field">Început planificat<input type="date" value={plannedStart} onChange={(event) => setPlannedStart(event.target.value)} /></label><label className="tw-field">Durată planificată, zile<input type="number" min="0" step="0.5" value={duration} onChange={(event) => setDuration(event.target.value)} /></label><label className="tw-field">Efort consemnat, ore<input type="number" min="0" step="0.5" value={effort} onChange={(event) => setEffort(event.target.value)} /></label><label className="tw-field tw-field-wide">Motiv pentru istoric<input value={reason} onChange={(event) => setReason(event.target.value)} required placeholder="Confirmare sau corectare de către manager" /></label></div>{error && <p className="tw-form-error">{error}</p>}<div className="tw-form-actions"><button type="button" className="tw-secondary-button" onClick={() => setEditing(false)} disabled={busy}>Anulează</button><button type="submit" className="tw-primary-button" disabled={busy}>{busy ? <LoaderCircle size={15} className="tw-spin" /> : <Check size={15} />} Salvează modificarea</button></div></form>}
  </section>;
}

export default function TeamWorkspace({ workspace, onOpenSource, onSave, onCreate, onOpenDecision, simulationOutput, focusedRecord }: Props) {
  const [group, setGroup] = useState<Group>('team');
  const [taskView, setTaskView] = useState<TaskView>('list');
  const [memberPanel, setMemberPanel] = useState<MemberPanel>('profile');
  const [selectedMemberId, setSelectedMemberId] = useState<string | null>(workspace.members[0]?.id || null);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const inspectorRef = useRef<HTMLElement | null>(null);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  useEffect(() => { if (!workspace.members.some((member) => member.id === selectedMemberId)) setSelectedMemberId(workspace.members[0]?.id || null); }, [workspace.members, selectedMemberId]);
  useEffect(() => {
    if (!focusedRecord?.id) return;
    const kind = focusedRecord.kind.toLocaleLowerCase();
    if (kind === 'member' && workspace.members.some((member) => member.id === focusedRecord.id)) { setGroup('team'); setSelectedMemberId(focusedRecord.id); setMemberPanel('profile'); }
    else if ((kind === 'task' || kind === 'deliverable') && (workspace.tasks.some((task) => task.id === focusedRecord.id) || workspace.deliverables.some((item) => item.id === focusedRecord.id))) { setGroup('tasks'); setTaskView('list'); setSelectedTaskId(focusedRecord.id); }
  }, [focusedRecord?.kind, focusedRecord?.id, workspace.members, workspace.tasks, workspace.deliverables]);
  const allTasks = workspace.tasks;
  const selectedMember = workspace.members.find((member) => member.id === selectedMemberId) || null;
  const filteredTasks = useMemo(() => allTasks.filter((task) => {
    const owner = ownerFor(task, workspace);
    const haystack = normalize(`${task.title} ${task.owner || ''} ${owner?.title || ''} ${task.status || ''}`);
    return (!search.trim() || haystack.includes(normalize(search))) && (statusFilter === 'all' || taskBucket(task) === statusFilter);
  }), [allTasks, workspace, search, statusFilter]);
  const selectedTask = [...allTasks, ...workspace.deliverables].find((task) => task.id === selectedTaskId) || null;
  const setTask = (id: string) => setSelectedTaskId(id || null);
  const linkedTaskDependencies = selectedTask?.depends_on || [];
  const taskSet = new Set(filteredTasks.map((task) => task.id));

  return <section className="team-workspace">
    <header className="tw-page-head"><h1>{group === 'team' ? 'Echipă' : 'Sarcini'}</h1>{group === 'team' && <button type="button" className="tw-primary-button" onClick={() => onCreate('member')}><Plus size={17} /> Membru</button>}</header>
    <div className="tw-toolbar">
      <div className="tw-group-tabs" role="tablist" aria-label="Spații de lucru"><button type="button" role="tab" aria-selected={group === 'team'} className={group === 'team' ? 'is-active' : ''} onClick={() => setGroup('team')}>Echipă</button><button type="button" role="tab" aria-selected={group === 'tasks'} className={group === 'tasks' ? 'is-active' : ''} onClick={() => setGroup('tasks')}>Sarcini</button></div>
      {group === 'tasks' && <div className="tw-task-view-tabs" role="tablist" aria-label="Vederi pentru același registru de sarcini">{taskViews.map(({ id, label, icon: Icon }) => <button type="button" role="tab" aria-selected={taskView === id} className={taskView === id ? 'is-active' : ''} key={id} onClick={() => setTaskView(id)}><Icon size={15} />{label}</button>)}</div>}
       <div className="tw-toolbar-actions">{group === 'tasks' && <><label className="tw-search"><Search size={16} /><input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Caută sarcini…" aria-label="Caută sarcini" /></label><TaskFilter statusFilter={statusFilter} setStatusFilter={setStatusFilter} /><button type="button" className="tw-primary-button" onClick={() => onCreate('task')}><Plus size={16} /> Sarcină</button></>}</div>
    </div>
    {group === 'team' ? <div className="tw-team-layout">
       <div className="tw-team-map-column"><TeamPeopleMap workspace={workspace} selectedMemberId={selectedMemberId} onSelectMember={(id) => { setSelectedMemberId(id); setMemberPanel('profile'); if (typeof window !== 'undefined' && window.matchMedia('(max-width: 900px)').matches) window.requestAnimationFrame(() => inspectorRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })); }} /></div>
      {selectedMember ? <MemberInspector key={selectedMember.id} member={selectedMember} workspace={workspace} panel={memberPanel} setPanel={setMemberPanel} onSelectTask={(id) => { setSelectedTaskId(id); if (id) { setGroup('tasks'); setTaskView('list'); } }} onOpenSource={onOpenSource} onSave={onSave} inspectorRef={inspectorRef} /> : <aside className="tw-inspector tw-inspector-empty"><CircleHelp size={22} /><strong>Nu există membri înregistrați.</strong><p>Adaugă o persoană pentru a construi harta echipei.</p><button type="button" className="tw-primary-button" onClick={() => onCreate('member')}><Plus size={15} /> Adaugă membru</button></aside>}
    </div> : <div className="tw-task-workspace">
      {taskView === 'list' && <TaskListView tasks={filteredTasks} workspace={workspace} selectedTaskId={selectedTaskId} onSelect={setTask} />}
      {taskView === 'gantt' && <GanttView tasks={filteredTasks} workspace={workspace} selectedTaskId={selectedTaskId} onSelect={setTask} simulationOutput={simulationOutput} />}
      {taskView === 'kanban' && <KanbanView tasks={filteredTasks} workspace={workspace} selectedTaskId={selectedTaskId} onSelect={setTask} />}
      {taskView === 'burndown' && <BurndownView tasks={filteredTasks} workspace={workspace} simulationOutput={simulationOutput} onSelect={setTask} onOpenSource={onOpenSource} onOpenDecision={onOpenDecision} />}
      {taskView === 'priorities' && <PriorityView tasks={filteredTasks} workspace={workspace} selectedTaskId={selectedTaskId} onSelect={setTask} onOpenSource={onOpenSource} onOpenDecision={onOpenDecision} />}
      {!filteredTasks.length && <div className="tw-empty-state">Nu există sarcini care corespund căutării și filtrului.</div>}
      {selectedTask && (taskSet.has(selectedTask.id) || selectedTask.kind === 'deliverable') && <SelectedTaskStrip key={selectedTask.id} task={selectedTask} workspace={workspace} onClose={() => setSelectedTaskId(null)} onOpenSource={onOpenSource} onSave={onSave} onSelectDependency={setTask} onOpenDecision={onOpenDecision} />}
      {simulationOutput && <div className="tw-simulation-context"><Activity size={14} /><span>Simulare salvată disponibilă: {simulationOutput.kind === 'simulation_run' ? `${simulationOutput.iterations.toLocaleString('ro-RO')} iterații, P50 ${simulationOutput.completionDays.p50.toFixed(1)} zile` : `Comparație, diferență P50 ${simulationOutput.completionDeltaDays.p50.toFixed(1)} zile`}.</span></div>}
      {taskView === 'gantt' && <p className="tw-data-note"><Clock3 size={14} />Barele folosesc doar începutul planificat și termenul consemnat. Termenul necunoscut rămâne fără poziție.</p>}
    </div>}
  </section>;
}
