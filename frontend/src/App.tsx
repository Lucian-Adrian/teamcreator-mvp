import AppHeader from './AppHeader';
import TeamWorkspace from './TeamWorkspace';
import ContextWorkspace from './ContextWorkspace';
import DecisionsWorkspace from './DecisionsWorkspace';
import { buildProjectReport } from './project-report';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity, AlertCircle, AlertTriangle, ArrowDownRight, ArrowRight, ArrowUpRight, Check,
  CheckCheck, ChevronDown, ChevronRight, CircleHelp, Clock3, File as FileIcon, FileArchive, FileCheck2,
  Download, FileText, Folder, GitBranch, History, Inbox, LayoutDashboard, LoaderCircle, Menu, Minus,
  MoreHorizontal, Network, Plus, Quote, Search, Send, Settings2, ShieldCheck, SlidersHorizontal,
  Sparkles, Upload, Users, X, ZoomIn, ZoomOut,
} from 'lucide-react';
import type { MemberType, ProjectChange, ProjectProposal, ProjectRecord, ProjectSource, ProjectSummary, ProjectWorkspace, SourceRef } from '../../shared/types';
import { approvalIsOnlyForBaseline } from '../../shared/proposal-safety.js';
import { streetlightSourcePack } from '../../shared/demo-source-pack.js';
import Simulation from './Simulation';
import type { SimulationIntervention, SimulationOutput, SimulationResult } from '../../shared/simulation';

type Page = 'context' | 'map' | 'simulation' | 'diagnostic';
type WorkspaceRecord = ProjectRecord;
type Project = ProjectSummary;
type Member = ProjectRecord;
type Source = ProjectSource;
type Workspace = ProjectWorkspace;
type SelectedNode = { kind: 'member' | 'task' | 'deliverable'; id: string } | null;

const API = '/api';
const navItems: { id: Page; label: string; icon: typeof LayoutDashboard }[] = [
  { id: 'context', label: 'Context', icon: Folder },
  { id: 'map', label: 'Hartă', icon: Network },
  { id: 'simulation', label: 'Simulare', icon: Activity },
  { id: 'diagnostic', label: 'Decizii', icon: LayoutDashboard },
];

async function api<T = any>(path: string, init?: RequestInit, allowAiSharing = false): Promise<T> {
  const headers = new Headers(init?.headers);
  if (!(init?.body instanceof FormData) && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  if ((init?.method || 'GET').toUpperCase() === 'POST' && !headers.has('Idempotency-Key')) headers.set('Idempotency-Key', crypto.randomUUID());
  if (allowAiSharing) headers.set('X-TeamCreator-AI', '1');
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || data.message || `Request failed (${response.status})`);
  return data as T;
}

function listFrom<T>(value: unknown, key: string): T[] {
  if (Array.isArray(value)) return value as T[];
  if (value && typeof value === 'object' && Array.isArray((value as any)[key])) return (value as any)[key] as T[];
  return [];
}

function displayDate(value?: unknown) {
  if (!value || typeof value !== 'string') return 'No date recorded';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat('ro-RO', { day: 'numeric', month: 'short', year: 'numeric' }).format(date);
}

function displayDateTime(value?: unknown) {
  if (!value || typeof value !== 'string') return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat('ro-RO', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(date);
}

function pause(milliseconds: number) { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }

function jobProgressLabel(job: Record<string, unknown>, fallback: string) {
  const phase = String(job.phase || job.status || fallback);
  const progress: string[] = [];
  const filesTotal = Number(job.files_total || 0);
  const segmentsTotal = Number(job.segments_total || 0);
  if (filesTotal > 0) progress.push(`${Number(job.files_processed || 0)}/${filesTotal} fișiere`);
  if (segmentsTotal > 0) progress.push(`${Number(job.segments_processed || 0)}/${segmentsTotal} secțiuni de text`);
  const label = phase.includes('with Codex CLI') ? 'Analizez sursele cu Codex' : phase.includes('Parsing') ? 'Citesc fișierele' : phase.includes('Queued') ? 'În coada de procesare' : phase;
  return progress.length ? `${label} · ${progress.join(' · ')}` : label;
}

async function pollJob(projectId: string, jobId: string, onUpdate: (job: Record<string, unknown>) => void) {
  for (let attempt = 0; attempt < 600; attempt += 1) {
    const response = await api(`/projects/${encodeURIComponent(projectId)}/jobs/${encodeURIComponent(jobId)}`);
    const job = (response as any).job || response;
    onUpdate(job);
    if (job.status === 'completed' || job.status === 'partial') return job.result;
    if (job.status === 'failed') throw new Error(String(job.error || 'Processing failed.'));
    await pause(500);
  }
  throw new Error('Procesarea continuă în fundal. Reîncarcă proiectul puțin mai târziu pentru a vedea rezultatele salvate.');
}

function relativeDate(value?: unknown) {
  if (!value || typeof value !== 'string') return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const days = Math.ceil((date.getTime() - Date.now()) / 86400000);
  if (days < 0) return `${Math.abs(days)}d overdue`;
  if (days === 0) return 'Due today';
  if (days === 1) return 'Due tomorrow';
  if (days <= 7) return `Due in ${days} days`;
  return '';
}

function titleCase(value?: unknown) {
  if (!value) return 'Necunoscut';
  const raw = String(value).trim().toLowerCase();
  const ro: Record<string, string> = {
    in_progress: 'În lucru', not_started: 'Neînceput', waiting_for_confirmation: 'Așteaptă confirmarea',
    needs_confirmation: 'Necesită confirmare', planned: 'Planificat', complete: 'Finalizat', completed: 'Finalizat',
    blocked: 'Blocat', baseline: 'De referință', reported: 'Raportat', unknown: 'Necunoscut',
    person: 'Persoană', organization: 'Organizație', group: 'Echipă', role: 'Rol', member: 'Membru',
    task: 'Sarcină', deliverable: 'Livrabil', risk: 'Risc', decision: 'Decizie', recommended_question: 'Întrebare recomandată',
    supported: 'Susținut de sursă', derived_by_rule: 'Derivat prin regulă', expert_observation: 'Observație expert', not_found: 'Negăsit',
    unreviewed: 'Neverificat', manager_confirmed: 'Confirmat de manager', manager_corrected: 'Corectat de manager', unresolved: 'Nerezolvat',
    proposed: 'Propus', applied: 'Aplicat', rejected: 'Respins', parsed: 'Citit', failed: 'Eșuat', unsupported: 'Nesuportat', empty: 'Fără conținut',
    create: 'Creare', update: 'Modificare', waiting: 'În așteptare',
  };
  return ro[raw] || raw.replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function projectLabel(project?: Project | null) {
  if (!project) return '';
  const item = project as any;
  return item.synthetic ? 'Date demonstrative' : 'Spațiu de proiect';
}

function projectDisplayName(project?: Project | null) {
  if (!project) return '';
  return project.synthetic && /onboarding scenario for .*archive move/i.test(project.description || '')
    ? 'Synthetic North Quay archive move'
    : project.name;
}

function explicitPeopleCount(workspace: Workspace) {
  return workspace.members.filter((member) => member.member_type === 'person').length;
}

function getRecordName(record?: WorkspaceRecord | null) {
  return record?.title || 'Untitled item';
}

function routeKind(kind: string) {
  return ({ member: 'members', task: 'tasks', deliverable: 'deliverables', risk: 'risks', decision: 'decisions' } as Record<string, string>)[kind] || kind;
}

function scheduledValue(record: WorkspaceRecord) { return record.due || record.current_forecast || record.baseline_due || ''; }
function isCompletedStatus(status: unknown) {
  const value = String(status || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
  return ['complete', 'completed', 'done', 'finished', 'finalized', 'accepted', 'finalizat', 'finalizata', 'terminat', 'terminata', 'incheiat', 'incheiata'].includes(value);
}
function scheduledLabel(record: WorkspaceRecord) {
  if (record.due) return `Termen curent · ${displayDate(record.due)}`;
  if (record.current_forecast) return `Prognoză · ${displayDate(record.current_forecast)}`;
  if (record.baseline_due) return `Dată de referință · ${displayDate(record.baseline_due)}`;
  return 'Fără dată consemnată';
}

function toPublicSnapshot(value: any) {
  if (value?.schema === 'teamcreator-public-snapshot/v1' && value.workspace) return value;
  if (value?.schema_version === 1 && value?.snapshot_type === 'project_state_only' && value.project && value.accepted_state) {
    const proposals = Array.isArray(value.pending_proposals) ? value.pending_proposals.map((proposal: any) => ({
      ...proposal,
      project_id: value.project.id,
      status: 'proposed',
      conflicts: [],
      missing_info: [],
      provider_mode: 'degraded',
      provider_model: null,
      items: (proposal.items || []).map((item: any) => ({ ...item, before: null, consequential: false, stale: Boolean(item.stale), review_state: item.review_state || 'unreviewed' })),
    })) : [];
    return {
      schema: 'teamcreator-public-snapshot/v1',
      exported_at: value.generated_at || new Date().toISOString(),
      workspace: { ...value.accepted_state, project: value.project, sources: value.sources || [], proposals, changes: value.changes || [], audit: value.audit || [] },
      source_texts: {},
      source_texts_complete: false,
    };
  }
  if (value?.project && Array.isArray(value.tasks) && Array.isArray(value.members)) {
    return { schema: 'teamcreator-public-snapshot/v1', exported_at: new Date().toISOString(), workspace: value, source_texts: {}, source_texts_complete: false };
  }
  throw new Error('Fișierul nu este un snapshot TeamCreator compatibil.');
}

function downloadDiagnosticReport(output: SimulationOutput, workspace: Workspace, audience: 'client' | 'sponsor') {
  const blob = new Blob([buildProjectReport(output, workspace, audience)], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `${workspace.project.name.replace(/[^a-z0-9-_]+/gi, '-').replace(/^-|-$/g, '')}-raport-${audience}.md`;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [activeId, setActiveId] = useState('');
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [page, setPage] = useState<Page>('context');
  const [contextPanel, setContextPanel] = useState<'sources' | 'integrations' | 'review' | 'history'>('sources');
  const [provider, setProvider] = useState<Record<string, unknown> | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [overlay, setOverlay] = useState<'create' | 'ingest' | null>(null);
  const [createName, setCreateName] = useState('');
  const [selectedNode, setSelectedNode] = useState<SelectedNode>(null);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [showAllAttention, setShowAllAttention] = useState(false);
  const [proposalBusyId, setProposalBusyId] = useState('');
  const [ingestStatus, setIngestStatus] = useState<{ names: string[]; progress: number; response?: any; error?: string } | null>(null);
  const [jobPhase, setJobPhase] = useState('');
  const [checkinText, setCheckinText] = useState('');
  const [checkinSource, setCheckinSource] = useState('');
  const [checkinSent, setCheckinSent] = useState(false);
  const [checkinCoverageMessage, setCheckinCoverageMessage] = useState('');
  const [checkinContinuationIds, setCheckinContinuationIds] = useState<string[]>([]);
  const [manualOpen, setManualOpen] = useState(false);
  const [manualKind, setManualKind] = useState<'member' | 'task'>('task');
  const [focusedDecisionId, setFocusedDecisionId] = useState('');
  const [retryingSources, setRetryingSources] = useState(false);
  const [retryResult, setRetryResult] = useState('');
  const [diagnosingProject, setDiagnosingProject] = useState(false);
  const [diagnosisMessage, setDiagnosisMessage] = useState('');
  const [snapshotImporting, setSnapshotImporting] = useState(false);
  const [snapshotImportMessage, setSnapshotImportMessage] = useState('');
  const snapshotInputRef = useRef<HTMLInputElement>(null);
  const [focusedSourceId, setFocusedSourceId] = useState('');
  const [focusedSourceRef, setFocusedSourceRef] = useState<SourceRef | null>(null);
  const [exportMenuOpen, setExportMenuOpen] = useState(false);
  const [exportingFormat, setExportingFormat] = useState('');
  const [simulationOutput, setSimulationOutput] = useState<SimulationOutput | null>(null);
  const [simulationProjectId, setSimulationProjectId] = useState('');
  const [diagnosticIntervention, setDiagnosticIntervention] = useState<SimulationIntervention | null>(null);
  const [simulationRunRequest, setSimulationRunRequest] = useState(0);
  const [aiShareEnabled, setAiShareEnabled] = useState(() => {
    try { return localStorage.getItem('teamcreator:ai-sharing') === 'enabled'; } catch { return false; }
  });

  const refreshProjects = async (preferredId?: string) => {
    const result = await api('/projects');
    const next = listFrom<Project>(result, 'projects');
    setProjects(next);
    const target = preferredId || activeId;
    if (target && next.some((project) => project.id === target)) setActiveId(target);
    else if (next.length && !next.some((project) => project.id === activeId)) setActiveId(next[0].id);
    else if (!next.length) setActiveId('');
    return next;
  };

  const refreshWorkspace = async (id = activeId) => {
    if (!id) { setWorkspace(null); return null; }
    const data = await api<Workspace>(`/projects/${encodeURIComponent(id)}/workspace`);
    setWorkspace(data);
    return data;
  };

  const refreshProvider = async () => {
    try { setProvider(await api('/provider')); } catch { setProvider({ status: 'unavailable', mode: 'degraded', provider: 'none' }); }
  };

  useEffect(() => {
    let live = true;
    Promise.allSettled([api('/projects'), api('/provider')]).then(([projectsResult, providerResult]) => {
      if (!live) return;
      if (projectsResult.status === 'fulfilled') {
        const next = listFrom<Project>(projectsResult.value, 'projects');
        setProjects(next);
        if (next.length) setActiveId(next[0].id);
      } else setError(projectsResult.reason?.message || 'Could not load projects.');
      if (providerResult.status === 'fulfilled') setProvider(providerResult.value as any);
      else setProvider({ status: 'unavailable' });
      setLoading(false);
    });
    return () => { live = false; };
  }, []);

  useEffect(() => {
    if (!activeId) { setWorkspace(null); return; }
    let live = true;
    setLoading(true);
    api<Workspace>(`/projects/${encodeURIComponent(activeId)}/workspace`)
      .then((data) => { if (live) { setWorkspace(data); setError(''); } })
      .catch((reason) => { if (live) setError(reason.message || 'Could not load the project workspace.'); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [activeId]);

  useEffect(() => {
    setSimulationOutput(null);
    setDiagnosticIntervention(null);
    if (!activeId) { setSimulationProjectId(''); return; }
    try {
      const saved = JSON.parse(localStorage.getItem(`teamcreator:simulation:${activeId}`) || 'null');
      setSimulationOutput(saved?.version === 1 ? saved.output : null);
    } catch { setSimulationOutput(null); }
    setSimulationProjectId(activeId);
  }, [activeId]);

  useEffect(() => {
    if (!activeId || simulationProjectId !== activeId) return;
    try {
      if (!simulationOutput) { localStorage.removeItem(`teamcreator:simulation:${activeId}`); return; }
      localStorage.setItem(`teamcreator:simulation:${activeId}`, JSON.stringify({ version: 1, savedAt: new Date().toISOString(), output: simulationOutput }));
    } catch { /* A full browser store does not block the current session result. */ }
  }, [activeId, simulationProjectId, simulationOutput]);

  useEffect(() => {
    try { localStorage.setItem('teamcreator:ai-sharing', aiShareEnabled ? 'enabled' : 'disabled'); } catch { /* The opt-in remains available for this session. */ }
  }, [aiShareEnabled]);

  const project = workspace?.project || projects.find((item) => item.id === activeId) || null;
  const pendingProposals = useMemo(() => (workspace?.proposals || []).filter((proposal) => proposal.status === 'proposed'), [workspace?.proposals]);

  const createProject = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!createName.trim()) return;
    setBusy(true); setError('');
    try {
      const result = await api('/projects', { method: 'POST', body: JSON.stringify({ name: createName.trim() }) });
      const created = (result as any).project || result;
      const id = created.id || (result as any).id;
      await refreshProjects(id);
      setActiveId(id);
      setCreateName(''); setOverlay(null); setPage('context'); setContextPanel('sources'); setOverlay('ingest');
    } catch (reason: any) { setError(reason.message || 'Could not create the project.'); }
    finally { setBusy(false); }
  };

  const createDemo = async () => {
    setBusy(true); setError('');
    try {
      const result = await api('/projects/demo', { method: 'POST', body: JSON.stringify({}) });
      const created = (result as any).project || result;
      const id = created.id || (result as any).id;
      await refreshProjects(id);
      setActiveId(id); setPage('map'); setOverlay(null);
    } catch (reason: any) { setError(reason.message || 'Could not create the sample project.'); }
    finally { setBusy(false); }
  };

  const runAiDemo = async () => {
    setBusy(true); setError('');
    try {
      const result = await api('/projects/demo-ai', { method: 'POST', body: JSON.stringify({}) });
      const created = (result as any).project || result;
      const id = String(created.id || (result as any).id || '');
      if (!id) throw new Error('The synthetic AI workspace was not created.');
      await refreshProjects(id);
      setActiveId(id); setPage('context'); setContextPanel('sources'); setOverlay('ingest');
      const files = streetlightSourcePack.map((item) => new File([item.text], item.name, { type: item.mediaType }));
      uploadFiles(files, id);
    } catch (reason: any) { setError(reason.message || 'Could not start the synthetic AI walkthrough.'); }
    finally { setBusy(false); }
  };

  const sendCheckin = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!checkinText.trim() || !activeId) return;
    setBusy(true); setError(''); setCheckinSent(false); setCheckinCoverageMessage(''); setCheckinContinuationIds([]);
    try {
      const initial = await api(`/projects/${encodeURIComponent(activeId)}/checkins`, {
        method: 'POST', body: JSON.stringify({ text: checkinText.trim(), sourceName: checkinSource.trim() || undefined }),
      }, aiShareEnabled);
      const queuedJob = (initial as any).job || initial;
      let result: any = initial;
      if (queuedJob.id) {
        setJobPhase('Submitting update');
        result = await pollJob(activeId, String(queuedJob.id), (job) => setJobPhase(jobProgressLabel(job, 'Processing update')));
      }
      const resultSources = listFrom<Source>(result?.sources, 'sources');
      if (result?.extraction?.coverage) {
        setCheckinCoverageMessage(extractionBatchMessage(result.extraction, resultSources));
        const remaining = Number(result.extraction.coverage.segments_remaining || 0);
        const continuationIds = resultSources.filter((source) => getSourceCoverage(source).canContinue).map((source) => source.id);
        setCheckinContinuationIds(remaining > 0 ? (continuationIds.length ? continuationIds : resultSources.map((source) => source.id)) : []);
      }
      await refreshWorkspace(); await refreshProvider();
      setCheckinText(''); setCheckinSource(''); setCheckinSent(true); setPage('context'); setContextPanel('review');
    } catch (reason: any) { setError(reason.message || 'Could not submit the update.'); }
    finally { setBusy(false); setJobPhase(''); }
  };

  const decideProposal = async (proposal: ProjectProposal, decision: 'apply' | 'reject', itemIds?: string[]) => {
    if (!activeId || !proposal.id) return;
    if (decision === 'apply' && !itemIds?.length) return;
    setProposalBusyId(String(proposal.id)); setError('');
    try {
      await api(`/projects/${encodeURIComponent(activeId)}/proposals/${encodeURIComponent(String(proposal.id))}/${decision}`, {
        method: 'POST', body: JSON.stringify(decision === 'apply' ? { itemIds } : {}),
      });
      await refreshWorkspace(); await refreshProvider();
    } catch (reason: any) {
      setError(reason.message || `Could not ${decision} this proposal.`);
      try { await refreshWorkspace(); } catch { /* Keep the action error visible if refresh is also unavailable. */ }
    }
    finally { setProposalBusyId(''); }
  };

  const reviewProposalItem = async (proposal: ProjectProposal, itemId: string, action: 'reject' | 'correct', reason: string, fields?: Record<string, unknown>) => {
    if (!activeId || !proposal.id) return;
    setProposalBusyId(`${proposal.id}:${itemId}`); setError('');
    try {
      await api(`/projects/${encodeURIComponent(activeId)}/proposals/${encodeURIComponent(String(proposal.id))}/items/${encodeURIComponent(itemId)}/review`, {
        method: 'POST', body: JSON.stringify({ action, reason: reason.trim(), ...(action === 'correct' ? { fields } : {}) }),
      });
      await refreshWorkspace(); await refreshProvider();
    } catch (reason: any) {
      setError(reason.message || 'Nu am putut salva revizuirea informației.');
      try { await refreshWorkspace(); } catch { /* Keep the action error visible if refresh is also unavailable. */ }
    } finally { setProposalBusyId(''); }
  };

  const updateRecord = async (kind: string, id: string, fields: Record<string, unknown>) => {
    if (!activeId) return;
    await api(`/projects/${encodeURIComponent(activeId)}/records/${encodeURIComponent(routeKind(kind))}/${encodeURIComponent(id)}`, {
      method: 'PATCH', body: JSON.stringify(fields),
    });
    await refreshWorkspace();
  };

  const performReview = async (proposalId: string, suffix: string, body: Record<string, unknown>) => {
    if (!activeId) throw new Error('Selectează un proiect.');
    setProposalBusyId(proposalId); setError('');
    try {
      await api(`/projects/${encodeURIComponent(activeId)}/proposals/${encodeURIComponent(proposalId)}/${suffix}`, { method: 'POST', body: JSON.stringify(body) });
      await refreshWorkspace(); await refreshProvider();
    } catch (reason: any) {
      setError(reason.message || 'Modificarea nu a putut fi salvată.');
      throw reason;
    } finally { setProposalBusyId(''); }
  };
  const decideAndWait = (proposal: ProjectProposal, decision: 'apply' | 'reject', itemIds?: string[]) => {
    if (decision === 'apply' && !itemIds?.length) return Promise.reject(new Error('Selectează informațiile de aplicat.'));
    return performReview(proposal.id, decision, decision === 'apply' ? { itemIds } : {});
  };
  const reviewAndWait = (proposal: ProjectProposal, itemId: string, action: 'reject' | 'correct', reason: string, fields?: Record<string, unknown>) =>
    performReview(proposal.id, `items/${encodeURIComponent(itemId)}/review`, { action, reason: reason.trim(), ...(action === 'correct' ? { fields } : {}) });

  const retrySources = async (sourceIds?: string[], options?: { reprocess?: boolean }) => {
    if (!activeId) return undefined;
    setRetryingSources(true); setRetryResult(''); setError('');
    setIngestStatus((current) => current ? { ...current, progress: 10, error: undefined } : current);
    try {
      const initial = await api(`/projects/${encodeURIComponent(activeId)}/sources/retry`, { method: 'POST', body: JSON.stringify({ sourceIds, ...options }) }, aiShareEnabled);
      const queuedJob = (initial as any).job || initial;
      let result: any = initial;
      if (queuedJob.id) {
        setJobPhase(String(queuedJob.phase || queuedJob.status || 'Retrying extraction'));
        result = await pollJob(activeId, String(queuedJob.id), (job) => {
          setJobPhase(jobProgressLabel(job, 'Retrying extraction'));
          setIngestStatus((current) => current ? { ...current, progress: Math.max(current.progress, 10 + Math.round(Number(job.progress || 0) * 0.85)), response: job.result || current.response } : current);
        });
      }
      const refreshed = await refreshWorkspace();
      await refreshProvider();
      const extraction = result?.extraction || {};
      const savedSources = refreshed?.sources || listFrom<Source>(result?.sources, 'sources');
      const message = extractionBatchMessage(extraction, savedSources);
      setRetryResult(message);
      setIngestStatus((current) => current ? { ...current, progress: 100, response: result, error: extraction.provider_mode === 'degraded' && provider?.provider !== 'none' ? extraction.error || 'Provider unavailable.' : undefined } : current);
      return { result, sources: savedSources };
    } catch (reason: any) {
      const message = reason.message || 'Retry could not run.';
      setRetryResult(message); setError(message);
      setIngestStatus((current) => current ? { ...current, error: message } : current);
    } finally { setRetryingSources(false); setJobPhase(''); }
  };

  const runProjectDiagnosis = async () => {
    if (!activeId || diagnosingProject) return;
    setDiagnosingProject(true); setDiagnosisMessage(''); setError('');
    try {
      const initial = await api(`/projects/${encodeURIComponent(activeId)}/diagnosis`, { method: 'POST', body: JSON.stringify({}) }, aiShareEnabled);
      const queuedJob = (initial as any).job || initial;
      let result: any = initial;
      if (queuedJob.id) {
        setJobPhase(String(queuedJob.phase || 'Preparing diagnosis'));
        result = await pollJob(activeId, String(queuedJob.id), (job) => setJobPhase(jobProgressLabel(job, 'Analysing project sources')));
      }
      await refreshWorkspace(activeId);
      await refreshProjects(activeId);
      await refreshProvider();
      const count = Number(result?.extraction?.records_proposed || 0);
      const notes = Array.isArray(result?.extraction?.missing_info) ? result.extraction.missing_info.slice(0, 2).join(' ') : '';
      setDiagnosisMessage(count
        ? `Codex a pregătit ${count} propuneri. Verifică citatele și aprobă-le în pasul Decizie.${notes ? ` ${notes}` : ''}`
        : `Codex nu a găsit o propunere de risc sau decizie susținută de surse.${notes ? ` ${notes}` : ''}`);
    } catch (reason: any) {
      setError(reason.message || 'Analiza proiectului nu a putut fi generată.');
    } finally {
      setDiagnosingProject(false); setJobPhase('');
    }
  };

  const continueCheckinReview = async () => {
    if (!checkinContinuationIds.length) return;
    const continuation = await retrySources(checkinContinuationIds);
    if (!continuation) return;
    const result = continuation.result || {};
    const sources = continuation.sources || [];
    const extraction = result.extraction || {};
    setCheckinCoverageMessage(extractionBatchMessage(extraction, sources));
    const remaining = Number(extraction.coverage?.segments_remaining ?? sources.reduce((count: number, source: Source) => count + (getSourceCoverage(source).remaining || 0), 0));
    const pendingIds = sources.filter((source: Source) => getSourceCoverage(source).canContinue).map((source: Source) => source.id);
    setCheckinContinuationIds(remaining > 0 ? (pendingIds.length ? pendingIds : checkinContinuationIds) : []);
  };

  const createManualRecord = async (kind: 'member' | 'task' | 'deliverable', fields: Record<string, unknown>) => {
    if (!activeId) return;
    setBusy(true); setError('');
    try {
      const result = await api(`/projects/${encodeURIComponent(activeId)}/records/${routeKind(kind)}`, { method: 'POST', body: JSON.stringify(fields) });
      await refreshWorkspace();
      const id = (result as any).record?.id;
      if (id) setSelectedNode({ kind, id });
      setManualOpen(false); setPage('map');
    } catch (reason: any) { setError(reason.message || 'Could not add this project record.'); }
    finally { setBusy(false); }
  };

  const importProjectSnapshot = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = '';
    if (!file) return;
    setSnapshotImporting(true); setSnapshotImportMessage(''); setError('');
    try {
      if (file.size > 8 * 1024 * 1024) throw new Error('Snapshot-ul trebuie să fie mai mic de 8 MiB.');
      const parsed = JSON.parse(await file.text());
      const snapshot = toPublicSnapshot(parsed);
      const response = await api<{ project?: Project }>('/projects/import', { method: 'POST', body: JSON.stringify({ snapshot }) });
      const imported = response.project;
      if (!imported?.id) throw new Error('Răspunsul de import nu conține proiectul.');
      await refreshProjects(imported.id);
      setActiveId(imported.id); setPage('context'); setContextPanel('sources'); setSelectedNode(null);
      setSnapshotImportMessage('Snapshot-ul a fost adăugat. Fișierele originale nu sunt incluse în copia exportată.');
    } catch (reason: any) {
      setSnapshotImportMessage(reason.message || 'Snapshot-ul nu a putut fi importat.');
    } finally { setSnapshotImporting(false); }
  };

  function uploadFiles(filesInput: FileList | File[], projectId = activeId) {
    const files = Array.from(filesInput);
    if (!files.length || !projectId) return;
    setError('');
    setIngestStatus({ names: files.map((file) => file.name), progress: 0 });
    const form = new FormData();
    files.forEach((file) => {
      form.append('files', file, file.name);
      form.append('relative_paths', (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name);
    });
    const request = new XMLHttpRequest();
    request.open('POST', `${API}/projects/${encodeURIComponent(projectId)}/ingest`);
    request.setRequestHeader('Idempotency-Key', crypto.randomUUID());
    if (aiShareEnabled) request.setRequestHeader('X-TeamCreator-AI', '1');
    request.upload.onprogress = (event) => {
      if (event.lengthComputable) setIngestStatus((current) => current ? { ...current, progress: Math.min(90, Math.round((event.loaded / event.total) * 90)) } : current);
    };
    request.onerror = () => setIngestStatus((current) => current ? { ...current, error: 'Upload did not reach the local project service.' } : current);
    request.onload = async () => {
      const body = (() => { try { return JSON.parse(request.responseText); } catch { return {}; } })();
      if (request.status < 200 || request.status >= 300) {
        setIngestStatus((current) => current ? { ...current, error: body.error || `Ingest failed (${request.status}).`, response: body } : current);
        return;
      }
      setIngestStatus((current) => current ? { ...current, progress: body.job?.id ? 10 : 100, response: body } : current);
      try {
        const queuedJob = body.job || body;
        let result = body;
        if (queuedJob.id) {
          setJobPhase(String(queuedJob.phase || queuedJob.status || 'Processing files'));
          result = await pollJob(projectId, String(queuedJob.id), (job) => {
            setJobPhase(jobProgressLabel(job, 'Processing files'));
            setIngestStatus((current) => current ? { ...current, progress: Math.max(current.progress, 10 + Math.round(Number(job.progress || 0) * 0.85)), response: job.result || current.response } : current);
          });
        }
        setIngestStatus((current) => current ? { ...current, progress: 100, response: result } : current);
        await refreshWorkspace(projectId); await refreshProjects(projectId); await refreshProvider();
      }
      catch (reason: any) { setIngestStatus((current) => current ? { ...current, error: reason.message || 'Upload finished, but the updated project did not load.' } : current); }
      finally { setJobPhase(''); }
    };
    request.send(form);
  }

  const openRecord = (kind: 'member' | 'task' | 'deliverable', id: string) => {
    setSelectedNode({ kind, id });
    setPage('map');
    setMobileNavOpen(false);
  };
  const openSource = (sourceId: string, ref: SourceRef | null = null) => {
    setFocusedSourceId(sourceId);
    setFocusedSourceRef(ref);
    setPage('context');
    setContextPanel('sources');
    setMobileNavOpen(false);
  };
  const downloadExport = async (format: 'json' | 'markdown') => {
    if (!activeId) return;
    setExportingFormat(format);
    setError('');
    try {
      const response = await fetch(`${API}/projects/${encodeURIComponent(activeId)}/export?format=${format}`);
      if (!response.ok) {
        const detail = await response.json().catch(() => ({}));
        throw new Error(detail.error || detail.message || `Export failed (${response.status}).`);
      }
      const blob = await response.blob();
      const suggestedName = response.headers.get('Content-Disposition')?.match(/filename\*?=(?:UTF-8''|\")?([^;\"]+)/i)?.[1];
      const filename = suggestedName ? decodeURIComponent(suggestedName.trim()) : `${projectDisplayName(project).replace(/[^a-z0-9-_]+/gi, '-').replace(/^-|-$/g, '')}.${format === 'json' ? 'json' : 'md'}`;
      const downloadUrl = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = downloadUrl;
      anchor.download = filename;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(downloadUrl), 1000);
      setExportMenuOpen(false);
    } catch (reason: any) {
      setError(reason.message || 'Could not export this project.');
    } finally {
      setExportingFormat('');
    }
  };

  useEffect(() => {
    if (!exportMenuOpen) return;
    const closeOutside = (event: PointerEvent) => {
      if (!(event.target instanceof Element) || !event.target.closest('.export-menu-wrap')) setExportMenuOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') setExportMenuOpen(false); };
    document.addEventListener('pointerdown', closeOutside);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOutside);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [exportMenuOpen]);

  const providerDegraded = provider?.mode === 'degraded' || provider?.provider === 'none';
  const providerText = provider?.provider === 'none' && provider?.ai_configured === true
    ? 'AI opțional disponibil'
    : provider?.provider === 'none'
    ? 'Procesare structurată · fără AI'
    : providerDegraded
      ? 'Furnizor AI indisponibil'
      : provider?.provider === 'codex_cli'
        ? 'Furnizor AI conectat'
        : provider?.status === 'unavailable'
          ? 'Furnizor indisponibil'
          : 'Verific starea procesării';

  if (loading && !workspace && !projects.length) {
    return <div className="loading-screen"><LoaderCircle className="spin" size={22} /><span>Opening your workspace</span></div>;
  }

  return (
    <div className="app-shell">
      <AppHeader
        projects={projects.map(item => ({ id: item.id, label: projectDisplayName(item) + (item.synthetic ? ' · demo sintetic' : '') }))}
        activeId={activeId} page={page} pendingCount={pendingProposals.length}
        providerText={providerText} providerMessage={String(provider?.message || '')} providerDegraded={providerDegraded}
        hasProject={Boolean(project)} exporting={Boolean(exportingFormat)} exportMenuOpen={exportMenuOpen}
        onProjectChange={(id) => { setActiveId(id); setSelectedNode(null); setFocusedSourceId(''); setFocusedSourceRef(null); setPage('context'); setContextPanel('sources'); }}
        onPageChange={setPage} onCreate={() => setOverlay('create')} onImport={() => setOverlay('ingest')}
        onToggleExport={() => setExportMenuOpen(value => !value)}
        exportMenu={exportMenuOpen && <div className="export-menu" role="menu" aria-label="Export proiect">
              <div className="export-menu-heading"><strong>Descarcă o copie</strong><button className="icon-button tiny" aria-label="Închide meniul exportului" onClick={() => setExportMenuOpen(false)}><X size={14} /></button></div>
              <button role="menuitem" className="export-option" onClick={() => downloadExport('json')} disabled={Boolean(exportingFormat)}><span className="export-option-icon"><FileText size={16} /></span><span><strong>{exportingFormat === 'json' ? 'Pregătesc snapshot-ul…' : 'Snapshot de proiect'}</strong><small>Înregistrări, surse și istoric de revizuire.</small></span><Download size={14} /></button>
              <button role="menuitem" className="export-option" onClick={() => downloadExport('markdown')} disabled={Boolean(exportingFormat)}><span className="export-option-icon"><FileText size={16} /></span><span><strong>{exportingFormat === 'markdown' ? 'Pregătesc rezumatul…' : 'Rezumat Markdown'}</strong><small>Starea acceptată a proiectului.</small></span><Download size={14} /></button>
              <p className="export-note">Fișierele originale nu sunt incluse în export.</p>
            </div>}
      />

      <main className="content-area">
        {error && <div className="error-banner"><AlertCircle size={17} /><span>{error}</span><button className="icon-button tiny" onClick={() => setError('')} aria-label="Închide mesajul"><X size={15} /></button></div>}
        {!project ? (
          <WelcomeState onCreate={() => setOverlay('create')} onDemo={createDemo} onAiDemo={runAiDemo} busy={busy} provider={provider} />
        ) : loading && !workspace ? (
          <div className="content-loading"><LoaderCircle className="spin" size={20} /> Deschid contextul proiectului…</div>
        ) : workspace ? (
          <>
            {page === 'context' && <ContextWorkspace workspace={workspace} tab={contextPanel} onTabChange={setContextPanel}
              onAddSources={() => setOverlay('ingest')} onOpenSource={(ref) => openSource(ref.source_id, ref)} onOpenRecord={openRecord}
              onOpenMap={() => setPage('map')}
              onRetry={async (ids, options) => { await retrySources(ids, options); }} retrying={retryingSources} retryResult={retryResult} onDecide={decideAndWait} onReviewItem={reviewAndWait}
              proposalBusyId={proposalBusyId} provider={provider} focusSourceId={focusedSourceId} focusRef={focusedSourceRef}
              onClearFocus={() => { setFocusedSourceRef(null); setFocusedSourceId(''); }}
              storageMode={import.meta.env.VITE_PUBLIC_DEMO === 'true' ? 'browser' : 'server'}
              toolbarContent={<><label className="ai-sharing-control"><input type="checkbox" checked={aiShareEnabled} onChange={(event) => setAiShareEnabled(event.target.checked)} /><span className="ai-sharing-switch" /><span>Permite AI</span></label>
                {import.meta.env.VITE_PUBLIC_DEMO === 'true' && <button className="text-action snapshot-import-action" onClick={() => snapshotInputRef.current?.click()} disabled={snapshotImporting}>{snapshotImporting ? 'Import…' : 'Importă snapshot'}</button>}
                <input ref={snapshotInputRef} type="file" accept=".json,application/json" hidden onChange={importProjectSnapshot} />
                {snapshotImportMessage && <span role="status">{snapshotImportMessage}</span>}
                {aiShareEnabled && <span className="ai-sharing-note">Textul surselor poate fi trimis furnizorului AI configurat la procesare.</span>}</>}
              reviewContent={<UpdatesPage workspace={workspace} text={checkinText} setText={setCheckinText} sourceName={checkinSource} setSourceName={setCheckinSource} onSubmit={sendCheckin} onContinueModelReview={continueCheckinReview} coverageMessage={checkinCoverageMessage} continuationPending={checkinContinuationIds.length > 0} retrying={retryingSources} busy={busy} jobPhase={jobPhase} proposals={pendingProposals} onDecide={decideProposal} onReviewItem={reviewProposalItem} onOpenSource={(ref) => openSource(ref.source_id, ref)} proposalBusyId={proposalBusyId} sent={checkinSent} />}
              historyContent={<HistoryPage workspace={workspace} />}
            />}
            {page === 'map' && <TeamWorkspace workspace={workspace} focusedRecord={selectedNode} onOpenSource={(ref) => openSource(ref.source_id, ref)}
              onSave={updateRecord} onCreate={(kind = 'task') => { setManualKind(kind); setManualOpen(true); }} simulationOutput={simulationOutput}
              onOpenDecision={(id) => { setFocusedDecisionId(id); setPage('diagnostic'); }} />}
            <div className="simulation-host" hidden={page !== 'simulation'}><Simulation workspace={workspace} onResult={setSimulationOutput} initialIntervention={diagnosticIntervention} autoRunKey={simulationRunRequest} /></div>
            {page === 'diagnostic' && <DecisionsWorkspace workspace={workspace} simulationOutput={simulationOutput} focusedRecordId={focusedDecisionId}
              onRunSimulation={() => setPage('simulation')}
              onReviewProposalItem={(proposalId, itemId, body) => performReview(proposalId, `items/${encodeURIComponent(itemId)}/review`, body)}
              onApplyProposalItems={(proposalId, itemIds) => performReview(proposalId, 'apply', { itemIds })}
              onSaveRecord={updateRecord} onRunScenario={(intervention) => { setDiagnosticIntervention(intervention); setSimulationRunRequest(value => value + 1); setPage('simulation'); }}
              onOpenSource={(ref) => openSource(ref.source_id, ref)} onOpenRecord={(kind, id) => { if (kind === 'member' || kind === 'task' || kind === 'deliverable') openRecord(kind, id); else setFocusedDecisionId(id); }} />}

          </>
        ) : null}
      </main>
      {overlay === 'create' && <Modal title="Creează un proiect" onClose={() => setOverlay(null)}>
        <form className="create-form" onSubmit={createProject}>
          <p className="modal-copy">Alege un nume ușor de recunoscut. Poți adăuga documentele imediat după.</p>
          <label className="field-label">Numele proiectului<input autoFocus value={createName} onChange={(event) => setCreateName(event.target.value)} placeholder="ex. Modernizarea iluminatului public" /></label>
          <div className="modal-footer"><button type="button" className="quiet-button" onClick={() => setOverlay(null)}>Renunță</button><button type="submit" className="primary-action" disabled={!createName.trim() || busy}>{busy ? <LoaderCircle size={15} className="spin" /> : <Plus size={15} />} Creează proiectul</button></div>
          <div className="demo-seed-callout"><span><Sparkles size={14} /> Deschide un proiect sintetic sau importă {streetlightSourcePack.length} surse de exemplu. Trimiterea către AI cere opt-in.</span><div><button type="button" className="quiet-button" onClick={createDemo} disabled={busy}><Sparkles size={13} /> Proiect demonstrativ</button><button type="button" className="primary-action" onClick={runAiDemo} disabled={busy}><Activity size={13} /> Procesează surse sintetice</button></div></div>
        </form>
      </Modal>}

      {overlay === 'ingest' && project && <IngestModal onClose={() => { setOverlay(null); setIngestStatus(null); setJobPhase(''); }} onViewSources={() => { setOverlay(null); setPage('context'); setContextPanel('sources'); }} onReviewUpdates={() => { setOverlay(null); setPage('context'); setContextPanel('review'); }} status={ingestStatus} phase={jobPhase} onUpload={uploadFiles} onRetry={(ids) => retrySources(ids)} retrying={retryingSources} retryResult={retryResult} provider={provider} aiShareEnabled={aiShareEnabled} onAiShareChange={setAiShareEnabled} />}
      {manualOpen && <ManualRecordModal workspace={workspace} initialKind={manualKind} busy={busy} onClose={() => setManualOpen(false)} onSave={createManualRecord} />}
      {mobileNavOpen && <button className="mobile-scrim" aria-label="Close menu" onClick={() => setMobileNavOpen(false)} />}
    </div>
  );
}

function WelcomeState({ onCreate, onDemo, onAiDemo, busy, provider }: { onCreate: () => void; onDemo: () => void; onAiDemo: () => void; busy: boolean; provider: Record<string, unknown> | null }) {
  return (
    <div className="welcome-wrap">
      <div className="welcome-card">
        <div className="welcome-icon"><GitBranch size={20} /></div>
        <div className="eyebrow">TEAMCREATOR · LIVRARE DE PROIECT</div>
        <h1>Proiectele tale, într-o singură privire.</h1>
        <p>Adaugă documentele proiectului. TeamCreator leagă oamenii, sarcinile și termenele de sursele lor, ca să vezi ce s-a schimbat și care este următorul pas.</p>
        <div className="welcome-actions"><button className="primary-action large-action" onClick={onAiDemo} disabled={busy}>{busy ? <LoaderCircle size={16} className="spin" /> : <Activity size={16} />} Procesează surse sintetice · {streetlightSourcePack.length} fișiere</button><button className="quiet-button demo-button" onClick={onDemo} disabled={busy}><Sparkles size={15} /> Proiect demonstrativ</button><button className="quiet-button" onClick={onCreate}>Creează proiect</button></div>
        <div className="welcome-divider" />
        <div className="welcome-proof"><div><FileCheck2 size={16} /><span>Sursele rămân vizibile</span></div><div><Network size={16} /><span>Legăturile pot fi corectate</span></div><div><ShieldCheck size={16} /><span>Managerul aprobă schimbările</span></div></div>
      </div>
      <div className="welcome-side"><div className="side-note-label"><span className="note-dot" /> TEAMCREATOR · LIVRARE DE PROIECT</div><h2>Context verificabil pentru echipa de livrare.</h2><div className="welcome-steps"><div><span>01</span><p><strong>Context</strong><small>Adaugă sursele și verifică afirmațiile.</small></p></div><div><span>02</span><p><strong>Hartă</strong><small>Leagă echipa, sarcinile și predările.</small></p></div><div><span>03</span><p><strong>Simulare</strong><small>Testează duratele și capacitatea cu ipoteze vizibile.</small></p></div><div><span>04</span><p><strong>Decizii și rapoarte</strong><small>Compară opțiuni și pregătește raportul potrivit.</small></p></div></div><div className="welcome-sample-note">{provider?.provider === 'none' ? 'Scenariu sintetic · procesare structurată · furnizor AI oprit implicit' : 'Surse și rezultate rămân revizuibile de manager.'}</div></div>
    </div>
  );
}

function Modal({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }) {
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className="modal-card" role="dialog" aria-modal="true" aria-label={title}><div className="modal-heading"><h2>{title}</h2><button className="icon-button" onClick={onClose} aria-label="Închide"><X size={18} /></button></div>{children}</section></div>;
}

function IngestModal({ onClose, onViewSources, onReviewUpdates, status, phase, onUpload, onRetry, retrying, retryResult, provider, aiShareEnabled, onAiShareChange }: { onClose: () => void; onViewSources: () => void; onReviewUpdates: () => void; status: { names: string[]; progress: number; response?: any; error?: string } | null; phase: string; onUpload: (files: FileList | File[]) => void; onRetry: (sourceIds?: string[]) => void; retrying: boolean; retryResult: string; provider: Record<string, unknown> | null; aiShareEnabled: boolean; onAiShareChange: (value: boolean) => void }) {
  const folderRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [paste, setPaste] = useState('');
  const [pasteError, setPasteError] = useState('');
  useEffect(() => { folderRef.current?.setAttribute('webkitdirectory', ''); folderRef.current?.setAttribute('directory', ''); }, []);
  const submitPaste = () => {
    if (!paste.trim()) { setPasteError('Lipește mai întâi contextul proiectului sau o notă de ședință.'); return; }
    const source = new globalThis.File([paste.trim()], 'pasted-project-context.txt', { type: 'text/plain' });
    onUpload([source]); setPaste(''); setPasteError('');
  };
  const responseSources = listFrom<Source>(status?.response?.sources, 'sources');
  const responseFiles = listFrom<any>(status?.response?.extraction, 'files');
  const batchCoverage = status?.response?.extraction?.coverage;
  const segmentsRemaining = Number(batchCoverage?.segments_remaining || 0);
  const segmentsSent = Number(batchCoverage?.segments_sent || 0);
  const segmentsTotal = Number(batchCoverage?.total_segments || 0);
  const continuationIds = responseSources.filter((source) => getSourceCoverage(source).canContinue).map((source) => source.id);
  const hasContinuation = segmentsRemaining > 0 && responseSources.length > 0;
  const done = status?.progress === 100 && !status?.error && !retrying;
  const partial = done && batchCoverage?.complete === false;
  const publicMode = provider?.provider === 'none';
  const aiConfigured = provider?.ai_configured === true;
  const structuredProposalCount = Math.max(Number(status?.response?.extraction?.records_proposed || 0), Array.isArray(status?.response?.proposals) ? status.response.proposals.length : status?.response?.proposal?.items?.length ? 1 : 0);
  return <Modal title="Adaugă documente" onClose={onClose}>
    <div className="ingest-modal-content">
      <p className="modal-copy">Adaugă materialele proiectului. Fiecare fișier este procesat separat; erorile rămân vizibile lângă sursele citite.</p>
      <div className="upload-options">
        <button className="upload-option" onClick={() => fileRef.current?.click()}><span className="upload-option-icon"><FileText size={18} /></span><strong>Alege fișiere</strong><small>{publicMode ? 'TXT, MD, CSV, TSV, XLS sau XLSX' : 'PDF, Word, Excel, CSV, Markdown sau text'}</small></button>
        <button className="upload-option" onClick={() => folderRef.current?.click()}><span className="upload-option-icon"><Folder size={18} /></span><strong>Alege un dosar</strong><small>Păstrează structura dosarelor la import</small></button>
        <input ref={fileRef} type="file" multiple hidden onChange={(event) => { if (event.target.files) onUpload(event.target.files); event.currentTarget.value = ''; }} />
        <input ref={folderRef} type="file" multiple hidden onChange={(event) => { if (event.target.files) onUpload(event.target.files); event.currentTarget.value = ''; }} />
      </div>
      <div className="paste-section"><div className="section-label"><span>Sau lipește contextul</span><span className="optional-label">notă de ședință · check-in · brief</span></div><textarea value={paste} onChange={(event) => setPaste(event.target.value)} placeholder="Lipește o notă sau un fragment. Va fi salvat ca sursă verificabilă." rows={4} /><div className="paste-actions">{pasteError && <span className="field-error">{pasteError}</span>}<button className="primary-action" onClick={submitPaste}><Upload size={15} /> Adaugă contextul</button></div></div>
      {status && <div className={`upload-progress ${status.error ? 'upload-error' : partial ? 'upload-partial' : done ? 'upload-done' : ''}`}><div className="progress-heading"><span>{status.error ? 'Importul necesită atenție' : partial ? 'Analiza s-a încheiat parțial' : done ? 'Import finalizat' : phase || 'Încarc documentele'}</span><strong>{status.progress}%</strong></div><div className="progress-track"><span style={{ width: `${status.progress}%` }} /></div><div className="upload-filenames">{status.names.map((name) => <span key={name}><FileIcon size={13} />{name}</span>)}</div>
        {status.error && <p className="field-error">{status.error}</p>}
      {done && <div className="ingest-outcome"><p>{responseSources.length ? `Au fost adăugate ${responseSources.length} ${responseSources.length === 1 ? 'sursă' : 'surse'}.` : 'Importul a fost primit.'} Verifică starea fiecărui fișier și propunerile citate.</p>{batchCoverage && <div className="ingest-coverage-summary"><strong>{segmentsRemaining > 0 ? `Analizate ${segmentsSent} secțiuni de text; ${segmentsRemaining} au rămas.` : batchCoverage.complete ? `Analiza AI a acoperit ${segmentsTotal || segmentsSent} secțiuni de text.` : 'Parserul și extragerea sunt afișate separat.'}</strong>{batchCoverage.note && <span>{batchCoverage.note}</span>}</div>}{publicMode && <div className="degraded-ingest"><AlertCircle size={15} /><div><strong>{structuredProposalCount ? 'Propuneri structurate, în așteptarea ta' : 'Sursele sunt salvate; textul liber rămâne sursă'}</strong><p>{structuredProposalCount ? 'Rândurile structurate au generat propuneri. Verifică fiecare citat înainte de aprobare.' : 'Fără furnizor AI, textul liber nu creează fapte. PDF și DOCX rămân inventariate ca nesuportate.'}{aiShareEnabled && aiConfigured ? ' Opt-in activ: textul surselor poate fi transmis furnizorului configurat.' : ' Niciun text nu a fost trimis la un furnizor AI.'}</p></div>{aiShareEnabled && aiConfigured && <button className="quiet-button" onClick={() => onRetry(responseSources.map((source) => source.id))} disabled={retrying}>{retrying ? <LoaderCircle size={14} className="spin" /> : <Activity size={14} />}{retrying ? 'Analizez cu AI' : 'Reia cu AI'}</button>}</div>}{!publicMode && status.response?.extraction?.provider_mode === 'degraded' && <div className="degraded-ingest"><AlertCircle size={15} /><div><strong>Fără furnizor AI disponibil</strong><p>{extractionBatchMessage(status.response.extraction, responseSources)}</p></div><button className="quiet-button" onClick={() => onRetry(responseSources.map((source) => source.id))} disabled={retrying}>{retrying ? <LoaderCircle size={14} className="spin" /> : <Activity size={14} />}{retrying ? phase || 'Reiau analiza' : 'Reia analiza'}</button></div>}{responseFiles.map((item: any, index: number) => <div key={item.name || index} className="file-result"><span className={/fail|error/i.test(String(item.status || item.parser_status)) ? 'result-failed' : 'result-ok'}>{/fail|error/i.test(String(item.status || item.parser_status)) ? <AlertCircle size={14} /> : <Check size={14} />}</span><span>{item.name || item.filename || `Fișierul ${index + 1}`}</span><small>{item.error || item.status || item.parser_status || 'Procesat'}</small></div>)}{retryResult && <p className={/only|unavailable|failed|could not/i.test(retryResult) ? 'field-error' : 'retry-success'}>{retryResult}</p>}<div className="ingest-footer-actions">{hasContinuation && <button className="quiet-button" onClick={() => onRetry(continuationIds.length ? continuationIds : responseSources.map((source) => source.id))} disabled={retrying}>{retrying ? <LoaderCircle size={14} className="spin" /> : <Activity size={14} />}{retrying ? phase || 'Continui analiza' : `Continuă analiza${aiShareEnabled && aiConfigured ? ' cu AI' : ''} · ${segmentsRemaining} rămase`}</button>}{status.response?.proposal && <button className="quiet-button" onClick={onReviewUpdates}>Revizuiește propunerile</button>}<button className="quiet-button result-close" onClick={onViewSources}>Vezi sursele</button><button className="quiet-button result-close" onClick={onClose}>Închide</button></div></div>}
      </div>}
      {!status && <div className="privacy-note"><ShieldCheck size={14} /><span>{publicMode ? `Mod browser public: TXT, MD, CSV, TSV, XLS și XLSX. PDF și DOCX sunt inventariate ca nesuportate. Fără AI, textul liber rămâne sursă; rândurile structurate pot crea propuneri citate. ${aiShareEnabled ? aiConfigured ? 'Opt-in activ, textul surselor poate fi transmis furnizorului configurat.' : 'Opt-in activ, dar nu este configurat niciun furnizor AI.' : 'AI este oprit până când îl activezi explicit.'}` : `Sursele și istoricul rămân în spațiul curent. ${provider?.mode === 'model' ? 'Extragerea folosește furnizorul AI local configurat.' : 'Furnizorul AI nu este disponibil momentan.'}`}</span></div>}
      <div className="ingest-ai-optin"><label className="ai-sharing-control"><input type="checkbox" checked={aiShareEnabled} onChange={(event) => onAiShareChange(event.target.checked)} /><span className="ai-sharing-switch" /><span>Permite procesarea AI</span></label><small>{aiShareEnabled ? aiConfigured || !publicMode ? 'Textul surselor și al check-in-urilor poate fi transmis furnizorului configurat.' : 'Opt-in memorat, dar furnizorul AI nu este configurat.' : 'Oprit implicit. Activarea permite trimiterea textului la furnizorul AI configurat.'}</small></div>
    </div>
  </Modal>;
}

function TodayPage({ workspace, onOpenRecord, onOpenSource, onReview, onAddUpdate, onViewSources, onIngest, onCreateManual, onRetry, retrying, retryResult, onAnalyzeDiagnosis, diagnosing, diagnosisMessage, canAnalyze, showAll, onToggleAll }: {
  workspace: Workspace; onOpenRecord: (kind: 'task' | 'deliverable', id: string) => void; onOpenSource: (ref: SourceRef) => void; onReview: () => void;
  onAddUpdate: () => void; onViewSources: () => void; onIngest: () => void; onCreateManual: () => void;
  onRetry: () => void; retrying: boolean; retryResult: string; onAnalyzeDiagnosis: () => void; diagnosing: boolean; diagnosisMessage: string; canAnalyze: boolean; showAll: boolean; onToggleAll: () => void;
}) {
  const blocked = workspace.tasks.filter((task) => /blocked|blocked_by/i.test(String(task.status || '')));
  const unknownOwners = [...workspace.tasks, ...workspace.deliverables].filter((record) => !record.owner);
  const attention = [
    ...blocked.map((task) => ({ kind: 'task' as const, record: task, reason: 'Blocked work', detail: task.status ? titleCase(task.status) : 'Blocked' })),
    ...unknownOwners.filter((item) => !blocked.some((task) => task.id === item.id)).map((record) => ({ kind: record.kind === 'deliverable' ? 'deliverable' as const : 'task' as const, record, reason: 'Owner not recorded', detail: 'Ownership is still unknown in the source material' })),
  ];
  const leadAttention = attention[0];
  const followUpRef = leadAttention?.record.source_refs?.[0];
  const followUpSource = followUpRef && workspace.sources.find((source) => source.id === followUpRef.source_id);
  const followUpQuestion = leadAttention
    ? leadAttention.reason === 'Blocked work'
      ? `What is still needed to unblock “${getRecordName(leadAttention.record)}”, and who can confirm it?`
      : `Who should own “${getRecordName(leadAttention.record)}”?`
    : '';
  const changes = [...workspace.changes].sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
  const datedItems = [...workspace.tasks, ...workspace.deliverables].filter((item) => scheduledValue(item) && !isCompletedStatus(item.status))
    .sort((a, b) => scheduledValue(a).localeCompare(scheduledValue(b)));
  const nextItems = [...datedItems.slice(0, 3), ...unknownOwners.filter((item) => !datedItems.some((record) => record.id === item.id)).slice(0, Math.max(0, 3 - Math.min(datedItems.length, 3)))];
  if (workspace.project.synthetic && /iluminat stradal/i.test(workspace.project.name)) return <StreetlightDiagnosis workspace={workspace} onOpenSource={onOpenSource} onOpenTask={(id) => onOpenRecord('task', id)} onOpenDecision={onAddUpdate} onAnalyzeDiagnosis={onAnalyzeDiagnosis} diagnosing={diagnosing} diagnosisMessage={diagnosisMessage} canAnalyze={canAnalyze} />;
  return (
    <>
      <div className="overview-metrics">
        <Metric icon={Users} label="Oameni" value={explicitPeopleCount(workspace)} note="identificați explicit" />
        <Metric icon={Users} label="Roluri și echipe" value={graphMembers(workspace).length} note="persoane, grupuri și roluri" />
        <Metric icon={GitBranch} label="Sarcini" value={workspace.tasks.length + workspace.deliverables.length} note="sarcini și livrabile" />
        <Metric icon={FileCheck2} label="Surse" value={workspace.sources.length} note="disponibile pentru verificare" />
        <Metric icon={CircleHelp} label="Propuneri" value={workspace.proposals.filter((item) => item.status === 'proposed').length} note="așteaptă decizia ta" />
      </div>

      {workspace.risks.length > 0 && <section className="diagnostic-strip surface-card"><div className="diagnostic-main"><span className="diagnostic-icon"><AlertTriangle size={17} /></span><div><div className="diagnostic-kicker">SEMNAL DE VERIFICAT · FĂRĂ SCOR DE RISC</div><h2>{workspace.risks[0].title}</h2><p>{workspace.risks[0].description || 'Sursa păstrează informația și contextul ei.'}</p><div className="diagnostic-owner">Urmărește: {workspace.risks[0].owner || 'Responsabil de confirmat'} · Stare: {titleCase(workspace.risks[0].status || 'necunoscut')}</div><EvidenceList refs={workspace.risks[0].source_refs || []} sources={workspace.sources} compact onOpenSource={onOpenSource} /></div></div><aside className="diagnostic-impact"><span>Ce poate afecta</span><strong>Plan intermediar → revizie tehnică → aprobare beneficiar</strong><small>Traseu din sarcini dependente. Data finală rămâne necunoscută.</small><button className="quiet-button" onClick={onAddUpdate}>Vezi întrebarea recomandată <ArrowRight size={13} /></button></aside></section>}

      {!workspace.members.length && !workspace.tasks.length && !workspace.deliverables.length && !workspace.risks.length && !workspace.decisions.length && workspace.sources.length > 0 && <SourceInventoryBanner pendingProposals={workspace.proposals.filter((proposal) => proposal.status === 'proposed').length} reviewedProposals={workspace.proposals.filter((proposal) => proposal.status !== 'proposed').length} onReview={onReview} onRetry={onRetry} onCreateManual={onCreateManual} retrying={retrying} retryResult={retryResult} />}

      <div className="today-grid">
        <section className="surface-card attention-card">
          <SectionHeading icon={AlertTriangle} title="Necesită atenție" detail={attention.length ? `${attention.length} elemente din contextul înregistrat` : 'Blocaje explicite și responsabili necunoscuți'} action={attention.length > 4 ? <button className="text-action" onClick={onToggleAll}>{showAll ? 'Arată mai puține' : 'Vezi toate'}</button> : undefined} />
          {attention.length ? <div className="attention-list">{attention.slice(0, showAll ? attention.length : 4).map(({ record, kind, reason, detail }) => (
            <button className="attention-row" key={`${kind}-${record.id}`} onClick={() => onOpenRecord(kind, record.id)}>
              <span className={`attention-icon ${reason === 'Blocked work' ? 'attention-red' : 'attention-amber'}`}>{reason === 'Blocked work' ? <AlertTriangle size={16} /> : <CircleHelp size={16} />}</span>
              <span className="attention-main"><strong>{getRecordName(record)}</strong><small>{reason} · {detail}</small></span>
              <span className="attention-tail">{record.due && displayDate(record.due)}<ChevronRight size={15} /></span>
            </button>
          ))}</div> : <div className="empty-inline"><span className="empty-check"><Check size={15} /></span><div><strong>No explicit blockers recorded</strong><p>This only reflects the information currently in the project workspace.</p></div></div>}
          <div className="attention-foot"><span><span className="small-dot dot-blocked" />{blocked.length} explicitly blocked</span><span><span className="small-dot dot-unknown" />{unknownOwners.length} unknown owner</span></div>
          {leadAttention && <div className="follow-up-card"><span className="follow-up-icon"><CircleHelp size={15} /></span><div className="follow-up-copy"><small>Suggested question for your next check-in</small><strong>{followUpQuestion}</strong><span>{followUpSource ? `From ${followUpSource.name} · ${followUpRef?.location || 'location not recorded'}` : 'Based on the recorded project state'}</span></div><div className="follow-up-actions"><button className="text-action" onClick={() => onOpenRecord(leadAttention.kind, leadAttention.record.id)}>Review item</button>{followUpRef && <button className="text-action" onClick={() => onOpenSource(followUpRef)}>Open source</button>}</div></div>}
        </section>

        <section className="surface-card next-card">
          <SectionHeading icon={ArrowRight} title="Next up" detail="Dates and ownership recorded in the project" />
          {nextItems.length ? <div className="next-list">{nextItems.map((record) => {
            const kind = record.kind === 'deliverable' ? 'deliverable' : 'task';
            const when = scheduledValue(record);
            const date = when ? new Date(when) : null;
            const calendarMonth = date && !Number.isNaN(date.getTime()) ? date.toLocaleString(undefined, { month: 'short' }) : '—';
            const calendarDay = date && !Number.isNaN(date.getTime()) ? String(date.getDate()) : '?';
            return <button className="next-row" key={`${kind}-${record.id}`} onClick={() => onOpenRecord(kind, record.id)}><span className="calendar-chip"><span>{calendarMonth}</span><strong>{calendarDay}</strong></span><span className="next-copy"><strong>{getRecordName(record)}</strong><small>{record.owner ? `Owner: ${record.owner}` : 'Owner unknown'} · {when ? `${scheduledLabel(record)}${relativeDate(when) ? ` · ${relativeDate(when)}` : ''}` : 'No date recorded'}</small></span><ChevronRight size={15} /></button>;
          })}</div> : <div className="empty-inline next-empty"><Clock3 size={17} /><div><strong>No upcoming dates recorded</strong><p>Dates will appear here when they are present in a source.</p></div></div>}
          <button className="full-width-link" onClick={() => onAddUpdate()}><Activity size={15} /> Add a check-in or meeting note <ArrowUpRight size={14} /></button>
        </section>

        <section className="surface-card changes-card">
          <SectionHeading icon={Activity} title="What changed" detail="Latest recorded events" action={<button className="text-action" onClick={() => onReview()}>Review updates</button>} />
          {changes.length ? <div className="change-list">{changes.slice(0, 4).map((change, index) => <ChangeRow key={String(change.id || index)} item={change} />)}</div> : <div className="empty-inline"><span className="empty-change"><History size={15} /></span><div><strong>No changes recorded yet</strong><p>New sources and decisions will appear here.</p></div></div>}
        </section>

        <section className="surface-card source-summary-card">
          <SectionHeading icon={FileText} title="Source coverage" detail="Check where the project context came from" action={<button className="text-action" onClick={onViewSources}>Open sources</button>} />
          <div className="source-summary"><div className="source-summary-number">{workspace.sources.length}</div><div><strong>{workspace.sources.length === 1 ? 'source in this workspace' : 'sources in this workspace'}</strong><p>Claims link back to their source when a quote is available.</p></div></div>
          {workspace.sources.slice(0, 3).map((source) => <div className="source-mini-row" key={source.id}><span className="file-type-icon"><FileText size={15} /></span><span>{source.name}</span><ParserBadge value={source.parser_status} /></div>)}
          {!workspace.sources.length && <button className="dashed-add" onClick={onIngest}><Plus size={15} /> Add the project folder</button>}
        </section>
      </div>
    </>
  );
}

function StreetlightDiagnosis({ workspace, onOpenSource, onOpenTask, onOpenDecision, onAnalyzeDiagnosis, diagnosing, diagnosisMessage, canAnalyze }: {
  workspace: Workspace; onOpenSource: (ref: SourceRef) => void; onOpenTask: (id: string) => void; onOpenDecision: () => void;
  onAnalyzeDiagnosis: () => void; diagnosing: boolean; diagnosisMessage: string; canAnalyze: boolean;
}) {
  const proposals = workspace.proposals.filter((proposal) => proposal.status === 'proposed');
  const proposedRisk = proposals.flatMap((proposal) => proposal.items.map((item) => ({ item, proposal }))).find(({ item }) => item.record_kind === 'risk');
  const proposedDecision = proposals.flatMap((proposal) => proposal.items.map((item) => ({ item, proposal }))).find(({ item }) => item.record_kind === 'decision');
  const risk = workspace.risks[0];
  const riskTitle = risk?.title || proposedRisk?.item.title;
  const riskDescription = risk?.description || proposedRisk?.item.fields.description || '';
  const riskRefs = risk?.source_refs || proposedRisk?.item.source_refs || [];
  const plan = workspace.tasks.find((task) => task.id === 't-01-intermediate-plan') || workspace.tasks.find((task) => /plan.*intermediar/i.test(task.title));
  const review = workspace.tasks.find((task) => task.id === 't-02-technical-review') || workspace.tasks.find((task) => /revizi.*tehnic/i.test(task.title));
  const approval = workspace.tasks.find((task) => task.id === 't-03-beneficiary-approval') || workspace.tasks.find((task) => /aproba.*beneficiar/i.test(task.title));
  const vendor = workspace.tasks.find((task) => /furnizor|echipament/i.test(task.title));
  const finalDeliverable = workspace.deliverables.find((item) => item.id === 'd-02-approved-pack') || workspace.deliverables.find((item) => /pachet.*tehnic/i.test(item.title));
  const timeline = [plan, review, approval].filter((item): item is ProjectRecord => Boolean(item));
  const decisionTitle = workspace.decisions[0]?.title || proposedDecision?.item.title;
  const decisionProposalText = workspace.decisions[0]?.description || proposedDecision?.item.fields.description || '';
  return <div className="streetlight-diagnosis">
    <div className="diagnosis-head"><div><div className="eyebrow">PASUL 03 · DIAGNOSTIC</div><h2>Ce poate afecta următoarea etapă?</h2><p>Semnale și recomandări legate de surse. Confirmă-le înainte să schimbe proiectul.</p></div><div className="diagnosis-head-actions"><button className="primary-action diagnosis-run-button" onClick={onAnalyzeDiagnosis} disabled={!canAnalyze || diagnosing}>{diagnosing ? <LoaderCircle size={14} className="spin" /> : <Sparkles size={14} />}{diagnosing ? 'Analizez sursele…' : 'Generează cu AI'}</button><span className="diagnosis-state"><span />{riskTitle ? 'Semnal documentat' : 'Fără diagnostic AI încă'}</span>{!canAnalyze && <small className="diagnosis-run-hint">Adaugă și procesează documentele pentru a porni analiza.</small>}</div></div>
    {diagnosisMessage && <div className="diagnosis-run-feedback"><Check size={14} />{diagnosisMessage}</div>}
    {riskTitle ? <section className="diagnosis-signal-card"><div className="diagnosis-signal-icon"><AlertTriangle size={17} /></div><div className="diagnosis-signal-copy"><div className="diagnosis-kicker">{proposedRisk && !risk ? 'PROPUNERE CODEX · AȘTEAPTĂ REVIZUIREA' : 'SEMNAL DE VERIFICAT · FĂRĂ SCOR DE RISC'}</div><h3>{riskTitle}</h3><p>{riskDescription || 'Verifică sursele citate pentru contextul semnalului.'}</p><div className="diagnosis-signal-meta">Urmărește: {risk?.owner || proposedRisk?.item.fields.owner || 'Responsabil de confirmat'} · Stare: {titleCase(risk?.status || proposedRisk?.item.fields.status || 'needs_confirmation')}</div><EvidenceList refs={riskRefs} sources={workspace.sources} compact onOpenSource={onOpenSource} /></div></section> : <section className="diagnosis-signal-card diagnosis-signal-empty"><div className="diagnosis-signal-icon"><CircleHelp size={17} /></div><div className="diagnosis-signal-copy"><div className="diagnosis-kicker">FĂRĂ SEMNALE CONFIRMATE</div><h3>Rulează analiza după ce sursele au fost procesate.</h3><p>Codex va propune doar riscuri și întrebări care se pot lega de citate exacte. Rezultatele intră în revizuirea managerului.</p></div></section>}
    <div className="diagnosis-body-grid"><section className="diagnosis-path-card"><div className="diagnosis-card-heading"><div><div className="eyebrow">CALEA DE LIVRARE</div><h3>Ce urmează în proiect?</h3></div><span>Din dependențele înregistrate</span></div>{timeline.length ? <div className="diagnosis-path">{timeline.map((item, index) => <React.Fragment key={item.id}><button className="diagnosis-path-node" onClick={() => onOpenTask(item.id)}><span className={index === 0 ? 'path-node-number path-node-current' : 'path-node-number'}>0{index + 1}</span><strong>{item.title}</strong><small>{item.owner || 'Responsabil necunoscut'} · {item.due ? displayDate(item.due) : 'Fără dată consemnată'}</small></button>{index < timeline.length - 1 && <ArrowRight className="diagnosis-path-arrow" size={17} />}</React.Fragment>)}</div> : <p className="diagnosis-path-note"><CircleHelp size={13} /> Nu au fost încă extrase sarcini pentru a arăta traseul.</p>}<p className="diagnosis-path-note"><CircleHelp size={13} /> Traseul arată dependențele înregistrate; nu estimează probabilitatea unei întârzieri.</p></section>
      <aside className="diagnosis-facts-card"><div className="eyebrow">CE ȘTIM ȘI CE LIPSEȘTE</div><div className="diagnosis-fact"><span>Plan intermediar</span><strong>{plan?.due ? displayDate(plan.due) : plan?.baseline_due ? displayDate(plan.baseline_due) : 'Fără dată consemnată'}</strong><small>{plan?.due || plan?.baseline_due ? 'Dată din sursele proiectului' : 'Nu completăm datele lipsă'}</small>{plan && <button onClick={() => onOpenTask(plan.id)}>Deschide sarcina <ChevronRight size={13} /></button>}</div><div className="diagnosis-fact diagnosis-fact-unknown"><span>Confirmarea furnizorului</span><strong>{vendor ? titleCase(vendor.status || 'unknown') : 'Nu este înregistrată'}</strong><small>{vendor?.due ? `Termen consemnat: ${displayDate(vendor.due)}` : 'Fără dată de livrare confirmată'}</small></div><div className="diagnosis-fact diagnosis-fact-unknown"><span>Livrabil final</span><strong>{finalDeliverable?.baseline_due ? displayDate(finalDeliverable.baseline_due) : 'Necunoscut'}</strong><small>{finalDeliverable ? 'Data de referință consemnată' : 'Nu este înregistrată o dată'}</small></div></aside></div>
    <section className="diagnosis-next-step"><span className="next-step-mark"><Sparkles size={16} /></span><div><div className="eyebrow">PASUL 04 · REVIZUIREA MANAGERULUI</div><h3>{decisionTitle || 'Recomandarea AI va apărea după analizarea surselor.'}</h3><p>{decisionProposalText || 'Codex pregătește o întrebare de lucru; nimic nu se aprobă sau trimite automat.'}</p></div><button className="primary-action" onClick={onOpenDecision}>{proposedDecision ? 'Revizuiește propunerea' : 'Deschide pasul Decizie'} <ArrowRight size={14} /></button></section>
  </div>;
}

function Metric({ icon: Icon, label, value, note }: { icon: typeof Users; label: string; value: number; note: string }) {
  return <div className="metric-card"><span className="metric-icon"><Icon size={16} /></span><div className="metric-label">{label}</div><div className="metric-value">{value}</div><div className="metric-note">{note}</div></div>;
}

function SectionHeading({ icon: Icon, title, detail, action }: { icon: typeof Activity; title: string; detail: string; action?: React.ReactNode }) {
  return <div className="section-heading"><div className="section-heading-main"><span className="section-icon"><Icon size={16} /></span><div><h2>{title}</h2><p>{detail}</p></div></div>{action}</div>;
}

function ChangeRow({ item }: { item: ProjectChange }) {
  return <div className="change-row"><span className="timeline-mark" /><div className="change-copy"><strong>{item.title}</strong><small>{item.summary}</small></div><span className="change-date">{displayDate(item.at)}</span></div>;
}

function proposalPreviewMember(workspace: Workspace, item: ProjectProposal['items'][number], index: number): ProjectRecord {
  const crops = ['top-left', 'top-right', 'bottom-left', 'bottom-right'] as const;
  const illustrative = workspace.project.synthetic && /iluminat stradal/i.test(workspace.project.name);
  return {
    id: `preview-${item.id}`, kind: 'member', title: item.title, status: null, owner: null, due: null, depends_on: [], source_refs: item.source_refs,
    evidence_state: 'supported', review_state: 'unreviewed', created_at: workspace.project.created_at, updated_at: workspace.project.updated_at,
    role: typeof item.fields.role === 'string' ? item.fields.role : null,
    member_type: item.fields.member_type || 'unknown',
    ...(illustrative ? { avatar_asset: '/brand/streetlight-team.png', avatar_crop: crops[index % crops.length], avatar_is_illustrative: true } : {}),
  };
}

function ProposalTopologyPreview({ workspace, onOpenSource, onReview }: { workspace: Workspace; onOpenSource: (ref: SourceRef) => void; onReview: () => void }) {
  const pendingItems = workspace.proposals.filter((proposal) => proposal.status === 'proposed').flatMap((proposal) => proposal.items.map((item) => ({ item, proposal })));
  const people = pendingItems.filter(({ item }) => item.record_kind === 'member');
  const work = pendingItems.filter(({ item }) => item.record_kind === 'task' || item.record_kind === 'deliverable');
  if (!people.length && !work.length) return null;
  const sources = workspace.sources;
  const personRecords = new Map(people.map(({ item }, index) => [item.title.trim().toLocaleLowerCase(), proposalPreviewMember(workspace, item, index)]));
  const countOwned = (name: string) => work.filter(({ item }) => String(item.fields.owner || '').trim().toLocaleLowerCase() === name.trim().toLocaleLowerCase()).length;
  const dependencyName = (value: unknown) => {
    const raw = String(value || '');
    const title = raw.replace(/^candidate:(?:task|deliverable):/i, '');
    return work.find(({ item }) => item.title.trim().toLocaleLowerCase() === title.trim().toLocaleLowerCase())?.item.title || title;
  };
  const handoffs = work.flatMap(({ item }) => {
    if (item.record_kind !== 'task' || !Array.isArray(item.fields.depends_on)) return [];
    return item.fields.depends_on.flatMap((dependency) => {
      const title = dependencyName(dependency);
      const previous = work.find((entry) => entry.item.title.trim().toLocaleLowerCase() === title.trim().toLocaleLowerCase());
      const from = String(previous?.item.fields.owner || '').trim();
      const to = String(item.fields.owner || '').trim();
      if (!previous || !from || !to || from.toLocaleLowerCase() === to.toLocaleLowerCase()) return [];
      return [{ previous: previous.item, next: item, from, to }];
    });
  });
  return <section className="proposal-topology-preview">
    <div className="proposal-preview-head"><div><div className="eyebrow">TOPOLOGIA PROPUSĂ · CODEX</div><h3>Previzualizare din documente</h3><p>Se vede înainte de aprobare, cu atribuiri, dependențe și citate la sursă.</p></div><button className="quiet-button" onClick={onReview}>Revizuiește schimbările <ArrowRight size={13} /></button></div>
    {people.length > 0 && <div className="proposal-preview-people">{people.map(({ item }, index) => {
      const member = proposalPreviewMember(workspace, item, index);
      return <article className="proposal-preview-person" key={item.id}><TeamAvatar member={member} size={38} /><span><strong>{item.title}</strong><small>{member.role || 'Rol de verificat'} · {countOwned(item.title)} elemente</small></span></article>;
    })}</div>}
    {handoffs.length > 0 && <div className="proposal-preview-handoffs"><div className="eyebrow">PREDĂRI PROPUSE · DIN DEPENDENȚE</div>{handoffs.slice(0, 4).map(({ previous, next, from, to }) => {
      const previousOwner = personRecords.get(from.toLocaleLowerCase());
      const nextOwner = personRecords.get(to.toLocaleLowerCase());
      const sourceRef = next.source_refs[0];
      const source = sourceRef && sources.find((candidate) => candidate.id === sourceRef.source_id);
      return <article className="proposal-preview-handoff" key={`${previous.id}-${next.id}`}><div className="proposal-preview-handoff-person"><TeamAvatar member={previousOwner} size={27} /><span><strong>{from}</strong><small>{previous.title}</small></span></div><ArrowRight size={15} /><div className="proposal-preview-handoff-person"><TeamAvatar member={nextOwner} size={27} /><span><strong>{to}</strong><small>{next.title}</small></span></div>{sourceRef && <button className="proposal-preview-source" onClick={() => onOpenSource(sourceRef)}><FileText size={11} />{source?.name || 'Citat'}</button>}</article>;
    })}</div>}
    {work.length > 0 && <div className="proposal-preview-work">{work.map(({ item }) => {
      const sourceRef = item.source_refs[0];
      const source = sourceRef && sources.find((candidate) => candidate.id === sourceRef.source_id);
      const dependencies = Array.isArray(item.fields.depends_on) ? item.fields.depends_on.map(dependencyName).filter(Boolean) : [];
      const due = item.fields.due || item.fields.baseline_due;
      return <article className="proposal-preview-task" key={item.id}><div className="proposal-preview-task-head"><span className={`proposal-preview-type ${item.record_kind}`}>{item.record_kind === 'deliverable' ? 'Livrabil' : 'Sarcină'}</span><strong>{item.title}</strong></div><div className="proposal-preview-task-meta"><span>{String(item.fields.owner || 'Responsabil neconfirmat')}</span><span>{item.fields.status ? titleCase(item.fields.status) : 'Stare de verificat'}</span><span>{due ? displayDate(due) : 'Fără dată consemnată'}</span></div>{dependencies.length > 0 && <small className="proposal-preview-dependency">După: {dependencies.join(' · ')}</small>}{sourceRef && <button className="proposal-preview-source" onClick={() => onOpenSource(sourceRef)}><FileText size={11} />{source?.name || 'Deschide citatul'} · {sourceRef.location}</button>}</article>;
    })}</div>}
    <div className="proposal-preview-foot"><ShieldCheck size={13} /><span>Propunerile nu au schimbat proiectul. Portretele din acest scenariu sunt ilustrative.</span><strong>{pendingItems.length} elemente de revizuit</strong></div>
  </section>;
}

function MapPage({ workspace, selectedNode, onSelect, onOpenSource, onReview, onSave, onCreateManual, onRetry, retrying, retryResult, simulationOutput, onRunSimulation }: { workspace: Workspace; selectedNode: SelectedNode; onSelect: (node: SelectedNode) => void; onOpenSource: (ref: SourceRef) => void; onReview: () => void; onSave: (kind: string, id: string, fields: Record<string, unknown>) => Promise<void>; onCreateManual: () => void; onRetry: () => void; retrying: boolean; retryResult: string; simulationOutput: SimulationOutput | null; onRunSimulation: () => void }) {
  const [visual, setVisual] = useState<'team' | 'gantt' | 'kanban' | 'burndown' | 'priorities'>('team');
  const [taskVisual, setTaskVisual] = useState<'gantt' | 'kanban' | 'burndown' | 'priorities'>('gantt');
  const [filter, setFilter] = useState<'all' | 'people' | 'tasks' | 'deliverables'>('all');
  const [listMode, setListMode] = useState(false);
  const [zoom, setZoom] = useState(100);
  const [impact, setImpact] = useState<any>(null);
  const [impactLoading, setImpactLoading] = useState(false);
  const [impactError, setImpactError] = useState('');
  const pendingTopology = workspace.proposals.filter((proposal) => proposal.status === 'proposed').flatMap((proposal) => proposal.items);
  const pendingMembers = pendingTopology.filter((item) => item.record_kind === 'member');
  const pendingWork = pendingTopology.filter((item) => item.record_kind === 'task' || item.record_kind === 'deliverable');
  const pendingHandoffs = pendingWork.filter((item) => item.record_kind === 'task' && Array.isArray(item.fields.depends_on) && item.fields.depends_on.some((dependency) => {
    const title = String(dependency).replace(/^candidate:(?:task|deliverable):/i, '').toLocaleLowerCase();
    const previous = pendingWork.find((candidate) => candidate.title.trim().toLocaleLowerCase() === title.trim());
    const from = String(previous?.fields.owner || '').trim(); const to = String(item.fields.owner || '').trim();
    return Boolean(from && to && from.toLocaleLowerCase() !== to.toLocaleLowerCase());
  })).length;
  const liveMembers = graphMembers(workspace).length;
  const liveTasks = workspace.tasks.length + workspace.deliverables.length;
  const liveHandoffs = workflowHandoffs(workspace).length;
  const previewOnly = !liveMembers && !liveTasks;
  const counts = { all: liveMembers + liveTasks, people: liveMembers, tasks: workspace.tasks.length, deliverables: workspace.deliverables.length };
  const selectedRecord = selectedNode?.kind === 'member' ? null : selectedNode ? findRecord(workspace, selectedNode.kind, selectedNode.id) : null;

  useEffect(() => {
    const compact = window.matchMedia('(max-width: 720px)');
    const syncView = () => setListMode(compact.matches);
    syncView();
    compact.addEventListener('change', syncView);
    return () => compact.removeEventListener('change', syncView);
  }, []);

  useEffect(() => {
    if (!selectedNode || !window.matchMedia('(max-width: 720px)').matches) return;
    const frame = requestAnimationFrame(() => document.querySelector('.inspector-panel')?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
    return () => cancelAnimationFrame(frame);
  }, [selectedNode?.kind, selectedNode?.id]);

  useEffect(() => {
    if (!selectedNode || selectedNode.kind !== 'task') { setImpact(null); setImpactError(''); return; }
    let live = true;
    setImpactLoading(true); setImpactError('');
    api(`/projects/${encodeURIComponent(workspace.project.id)}/impact?taskId=${encodeURIComponent(selectedNode.id)}`)
      .then((result) => { if (live) setImpact(result); })
      .catch((reason: any) => { if (live) setImpactError(reason.message || 'Impact path is not available.'); })
      .finally(() => { if (live) setImpactLoading(false); });
    return () => { live = false; };
  }, [selectedNode?.kind, selectedNode?.id, workspace.project.id]);

  return <>
    <div className="view-heading map-view-heading"><h1>{visual === 'team' ? 'Echipă' : 'Sarcini'}</h1><div className="map-summary-strip"><span>{workspace.project.synthetic ? 'Exemplu sintetic · ' : ''}{previewOnly ? pendingMembers.length : liveMembers} membri</span><span>{previewOnly ? pendingWork.filter(item => item.record_kind === 'task').length : workspace.tasks.length} sarcini</span></div></div>
    {!workspace.members.length && !workspace.tasks.length && !workspace.deliverables.length && <ProposalTopologyPreview workspace={workspace} onOpenSource={onOpenSource} onReview={onReview} />}
    <div className={`map-layout ${selectedNode ? 'map-has-selection' : ''}`}>
      <div className="map-main">
        {!workspace.members.length && !workspace.tasks.length && !workspace.deliverables.length && !workspace.risks.length && !workspace.decisions.length && workspace.sources.length > 0 && <SourceInventoryBanner pendingProposals={workspace.proposals.filter((proposal) => proposal.status === 'proposed').length} reviewedProposals={workspace.proposals.filter((proposal) => proposal.status !== 'proposed').length} onReview={onReview} onRetry={onRetry} onCreateManual={onCreateManual} retrying={retrying} retryResult={retryResult} />}
        <div className="map-section-tabs" role="tablist" aria-label="Echipă și sarcini"><button role="tab" aria-selected={visual === 'team'} className={visual === 'team' ? 'section-tab section-tab-active' : 'section-tab'} onClick={() => setVisual('team')}>Echipă</button><button role="tab" aria-selected={visual !== 'team'} className={visual !== 'team' ? 'section-tab section-tab-active' : 'section-tab'} onClick={() => setVisual(taskVisual)}>Sarcini</button></div>
        <div className="map-toolbar map-toolbar-rich">
          {visual !== 'team' ? <div className="map-visual-tabs" role="tablist" aria-label="Vederi pentru sarcini">{([{ id: 'gantt', label: 'Gantt', icon: GitBranch }, { id: 'kanban', label: 'Kanban', icon: LayoutDashboard }, { id: 'burndown', label: 'Burndown', icon: Activity }, { id: 'priorities', label: 'Priorități', icon: AlertTriangle }] as const).map(({ id, label, icon: Icon }) => <button key={id} role="tab" aria-selected={visual === id} className={visual === id ? 'visual-tab visual-tab-active' : 'visual-tab'} onClick={() => { setVisual(id); setTaskVisual(id); }}><Icon size={17} />{label}</button>)}</div> : <span className="team-view-label"><Users size={17} />Oameni și predări</span>}
          <div className="map-tools"><button className="primary-action add-record-map" onClick={onCreateManual}><Plus size={17} /> Adaugă</button>{visual === 'team' && <><button className={`icon-button ${listMode ? 'tool-selected' : ''}`} aria-label="Arată lista" title="Listă" onClick={() => setListMode(true)}><SlidersHorizontal size={18} /></button><button className={`icon-button ${!listMode ? 'tool-selected' : ''}`} aria-label="Arată topologia" title="Hartă" onClick={() => setListMode(false)}><Network size={18} /></button></>}</div>
        </div>
        {visual === 'team' && <><div className="map-caption"><span><span className="caption-dot source-edge" />Responsabilitate din sursă</span><span><span className="caption-dot handoff-edge" />Predare între responsabili</span><span><span className="caption-dot approval-edge" />Revizuire sau aprobare înregistrată</span><span className="caption-tip">{selectedNode ? 'Legăturile asociate sunt evidențiate' : 'Alege o persoană sau sarcină pentru detalii'}</span></div>{listMode ? <RecordList workspace={workspace} filter={filter} onSelect={onSelect} /> : <Topology workspace={workspace} filter={filter} zoom={zoom} selectedNode={selectedNode} onSelect={onSelect} />}</>}
        {visual === 'gantt' && <GanttView workspace={workspace} onSelect={onSelect} simulationOutput={simulationOutput} onRunSimulation={onRunSimulation} />}
        {visual === 'kanban' && <TaskBoardView workspace={workspace} onSelect={onSelect} />}
        {visual === 'burndown' && <BurndownView workspace={workspace} />}
        {visual === 'priorities' && <PriorityView workspace={workspace} onSelect={onSelect} />}
        {visual === 'team' && <div className="map-legend-note"><CircleHelp size={14} /><span>Legăturile folosesc responsabilul și dependențele înregistrate. Verde: predare. Mov: revizuire sau aprobare.</span></div>}
      </div>
      {selectedNode && <RecordInspector key={`${selectedNode.kind}-${selectedNode.id}`} workspace={workspace} node={selectedNode} record={selectedRecord} onClose={() => onSelect(null)} onSelect={onSelect} onOpenSource={onOpenSource} onSave={onSave} impact={impact} impactLoading={impactLoading} impactError={impactError} />}
    </div>
  </>;
}

function workflowHandoffs(workspace: Workspace) {
  const records = [...workspace.tasks, ...workspace.deliverables];
  const byId = new Map(records.map((record) => [record.id, record]));
  const ownerFor = (record?: ProjectRecord) => record ? workspace.members.find((member) => member.id === record.owner_id || member.title.trim().toLowerCase() === record.owner?.trim().toLowerCase()) : undefined;
  return (workspace.dependencies || []).flatMap((dependency) => {
    const previous = byId.get(dependency.to_id);
    const next = byId.get(dependency.from_id);
    const fromMember = ownerFor(previous);
    const toMember = ownerFor(next);
    if (!previous || !next || !fromMember || !toMember || fromMember.id === toMember.id) return [];
    return [{ id: dependency.id, previous, next, fromMember, toMember, source_refs: dependency.source_refs || [] }];
  });
}

function TeamAvatar({ member, size = 42 }: { member?: ProjectRecord; size?: number }) {
  const crop = member?.avatar_crop || 'top-left';
  const position = ({ 'top-left': '0% 0%', 'top-right': '100% 0%', 'bottom-left': '0% 100%', 'bottom-right': '100% 100%' } as const)[crop];
  const label = member?.title || 'Responsabil de confirmat';
  if (member?.avatar_asset) return <span aria-label={member.avatar_is_illustrative ? `Portret ilustrativ · ${label}` : label} title={member.avatar_is_illustrative ? 'Portret ilustrativ pentru scenariul demonstrativ' : label} className="team-avatar team-avatar-photo" style={{ width: size, height: size, backgroundImage: `url(${member.avatar_asset})`, backgroundPosition: position }} />;
  return <span className="team-avatar" aria-label={label} style={{ width: size, height: size }}>{label.split(/\s+/).map((part) => part[0]).slice(0, 2).join('').toUpperCase()}</span>;
}

function TeamFlowView({ workspace, onSelect, onOpenSource }: { workspace: Workspace; onSelect: (node: SelectedNode) => void; onOpenSource: (ref: SourceRef) => void }) {
  const handoffs = workflowHandoffs(workspace);
  const sourceName = (id: string) => workspace.sources.find((source) => source.id === id)?.name || 'Sursă';
  return <div className="team-flow-view">
    <div className="team-people-row">{graphMembers(workspace).filter((member) => member.member_type === 'person').map((member) => {
      const owned = [...workspace.tasks, ...workspace.deliverables].filter((record) => record.owner_id === member.id || record.owner?.trim().toLowerCase() === member.title.trim().toLowerCase()).length;
      return <button key={member.id} className="team-person-card" onClick={() => onSelect({ kind: 'member', id: member.id })}><TeamAvatar member={member} size={56} /><strong>{member.title}</strong><span>{member.role || 'Rol nespecificat'}</span><small>{owned} sarcini și livrabile alocate</small></button>;
    })}</div>
    <section className="handoff-section"><div className="section-heading"><div><h3>Predări de lucru între colegi</h3><p>Legătura apare numai când o sarcină depinde de alta și are sursă.</p></div><span className="handoff-count">{handoffs.length} documentate</span></div>
      {handoffs.length ? <div className="handoff-list">{handoffs.map((item) => <article className="handoff-card" key={item.id}><div className="handoff-people"><button onClick={() => onSelect({ kind: 'member', id: item.fromMember.id })}><TeamAvatar member={item.fromMember} size={34} /><span><strong>{item.fromMember.title}</strong><small>{item.previous.title}</small></span></button><ArrowRight size={19} /><button onClick={() => onSelect({ kind: 'member', id: item.toMember.id })}><TeamAvatar member={item.toMember} size={34} /><span><strong>{item.toMember.title}</strong><small>{item.next.title}</small></span></button></div><div className="handoff-evidence"><span className="evidence-badge"><Check size={12} /> Dependență cu citat</span>{item.source_refs.slice(0, 2).map((ref, index) => <button key={`${ref.source_id}-${index}`} onClick={() => onOpenSource(ref)}><FileText size={12} />{sourceName(ref.source_id)} · {ref.location}</button>)}</div></article>)}</div> : <div className="view-empty">Nu există încă o predare citată între persoane diferite. Sarcinile și responsabilitățile rămân vizibile în celelalte vederi.</div>}
    </section>
    {workspace.members.some((member) => member.avatar_is_illustrative) && <p className="portrait-note">Portretele sunt generate pentru prezentarea scenariului sintetic. Nu reprezintă angajați reali.</p>}
  </div>;
}

function projectTaskRegistry(workspace: Workspace) { return workspace.tasks; }

function TaskBoardView({ workspace, onSelect }: { workspace: Workspace; onSelect: (node: SelectedNode) => void }) {
  const tasks = projectTaskRegistry(workspace);
  const groups = [
    { title: 'În lucru', match: (status: string) => /progress|active|doing/i.test(status) },
    { title: 'Așteaptă confirmare', match: (status: string) => /wait|block|confirm/i.test(status) },
    { title: 'Completate', match: (status: string) => isCompletedStatus(status) },
    { title: 'Următoare', match: (status: string) => !/progress|active|doing|wait|block|confirm/i.test(status) && !isCompletedStatus(status) },
  ];
  const visibleGroups = groups.map((group) => ({ ...group, records: tasks.filter((task) => group.match(String(task.status || ''))) })).filter((group) => group.records.length > 0);
  return <div className="task-board-view">{visibleGroups.length ? visibleGroups.map((group) => {
    const records = group.records;
    return <section className="task-lane" key={group.title}><div className="task-lane-heading"><h3>{group.title}</h3><span>{records.length}</span></div>{records.map((task) => {
      const owner = graphMembers(workspace).find((member) => member.id === task.owner_id || member.title.trim().toLowerCase() === task.owner?.trim().toLowerCase());
      return <button className="task-card" key={task.id} onClick={() => onSelect({ kind: 'task', id: task.id })}><span className={`task-status-pin ${/wait|block|confirm/i.test(String(task.status)) ? 'task-status-wait' : /progress|active|doing/i.test(String(task.status)) ? 'task-status-live' : ''}`} /><strong>{task.title}</strong><small>{task.owner || 'Responsabil de confirmat'}</small><span className="task-detail-badges"><em>{task.planned_duration_days != null ? `Durată · ${task.planned_duration_days} zile` : 'Durată necunoscută'}</em><em>{task.effort_hours != null ? `Efort · ${task.effort_hours} ore` : 'Efort neraportat'}</em></span><span className="task-card-foot"><span><TeamAvatar member={owner} size={25} />{owner?.title || 'Rol neconfirmat'}</span><em>{task.due ? displayDate(task.due) : 'Fără dată în surse'}</em></span></button>;
    })}</section>;
  }) : <div className="view-empty">Nu sunt sarcini de afișat în board.</div>}</div>;
}

function GanttView({ workspace, onSelect, simulationOutput, onRunSimulation }: { workspace: Workspace; onSelect: (node: SelectedNode) => void; simulationOutput: SimulationOutput | null; onRunSimulation: () => void }) {
  const tasks = projectTaskRegistry(workspace);
  const plannedDates = tasks.flatMap((task) => [task.planned_start, task.due].filter((value): value is string => Boolean(value)).map((value) => new Date(value).getTime()).filter(Number.isFinite));
  const axisStart = plannedDates.length ? Math.min(...plannedDates) : 0;
  const axisEnd = plannedDates.length ? Math.max(...plannedDates) : 0;
  const daySpan = Math.max(1, Math.ceil((axisEnd - axisStart) / 86400000));
  const tickPercents = axisEnd > axisStart ? [0, 50, 100] : plannedDates.length ? [0] : [];
  const calendarTicks = tickPercents.map((percent) => {
    const timestamp = axisStart + (axisEnd - axisStart) * percent / 100;
    const label = new Intl.DateTimeFormat('ro-RO', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(timestamp));
    return { position: ((timestamp - axisStart) / 86400000) / daySpan * 100, align: percent === 0 ? 'start' : percent === 100 ? 'end' : 'center', label };
  });
  const result = simulationOutput?.kind === 'simulation_comparison' ? simulationOutput.scenario : simulationOutput;
  const medianPath = result?.paths.find((path) => path.targetQuantile === 50) || result?.paths[0];
  const simulatedById = new Map((medianPath?.tasks || []).map((point) => [point.id, point]));
  const recordsById = new Map(tasks.map((task) => [task.id, task]));
  return <section className="gantt-view">
    <div className="gantt-heading"><div><strong>{tasks.length} sarcini în același registru cu Kanban și Priorități</strong><small>Barele și axa folosesc doar date calendaristice consemnate. Durata P50 simulată rămâne estimare relativă.</small></div>{!result && <button className="quiet-button" onClick={onRunSimulation}><Activity size={13} /> Rulează simularea pentru intervale modelate</button>}</div>
    <div className="gantt-scroll"><div className="gantt-grid" style={{ minWidth: 960 }}><div className="gantt-header"><span>Sarcină</span><span>Responsabil</span><span>Durată</span><span>Efort</span><span>Termen</span><div className="gantt-axis"><strong>Plan / calendar</strong><div className="gantt-axis-ticks">{calendarTicks.length ? calendarTicks.map((tick) => <span key={tick.position} style={{ left: `${tick.position}%`, transform: tick.align === 'start' ? 'none' : tick.align === 'end' ? 'translateX(-100%)' : 'translateX(-50%)' }}>{tick.label}</span>) : <span>Fără date calendaristice consemnate</span>}</div></div></div>
      {tasks.map((task) => {
        const start = task.planned_start ? new Date(task.planned_start) : null;
        const due = task.due ? new Date(task.due) : null;
        const startTime = start && Number.isFinite(start.getTime()) ? start.getTime() : null;
        const dueTime = due && Number.isFinite(due.getTime()) ? due.getTime() : null;
        const left = startTime != null && plannedDates.length ? Math.max(0, ((startTime - axisStart) / 86400000) / daySpan * 100) : dueTime != null && plannedDates.length ? Math.max(0, ((dueTime - axisStart) / 86400000) / daySpan * 100) : null;
        const right = dueTime != null && startTime != null && plannedDates.length ? Math.max(left || 0, ((dueTime - axisStart) / 86400000) / daySpan * 100) : null;
        const simPoint = simulatedById.get(task.id);
        const owner = graphMembers(workspace).find((member) => member.id === task.owner_id || member.title.trim().toLowerCase() === task.owner?.trim().toLowerCase());
        const dependencies = (task.depends_on || []).map((id) => recordsById.get(id)?.title).filter(Boolean);
        return <div className="gantt-row" key={task.id}><button className="gantt-task-name" onClick={() => onSelect({ kind: 'task', id: task.id })}><strong>{task.title}</strong>{dependencies.length ? <small>Depinde de: {dependencies.slice(0, 2).join(', ')}{dependencies.length > 2 ? ` +${dependencies.length - 2}` : ''}</small> : <small>Fără dependență consemnată</small>}</button><span className="gantt-owner"><TeamAvatar member={owner} size={25} />{task.owner || 'Necunoscut'}</span><span className="gantt-cell-value">{task.planned_duration_days != null ? `${task.planned_duration_days} zile` : simPoint ? <>{simPoint.durationDays.toFixed(1)} zile <small>model P50</small></> : 'Necunoscută'}</span><span className="gantt-cell-value">{task.effort_hours != null ? `${task.effort_hours} ore` : 'Neraportat'}</span><span className="gantt-cell-value">{task.due ? displayDate(task.due) : 'Necunoscut'}</span><div className="gantt-track">{left != null && right != null && right > left ? <span className="gantt-plan-bar" title="Interval din data de început și termen consemnate" style={{ left: `${left}%`, width: `${Math.max(1.5, right - left)}%` }} /> : left != null ? <span className="gantt-milestone" title="Termen consemnat; începutul lipsește" style={{ left: `${left}%` }} /> : <span className="gantt-no-date">Fără dată în calendar</span>}</div></div>;
      })}
      {!tasks.length && <div className="view-empty">Nu există sarcini în registru.</div>}
    </div></div>
    <div className="gantt-legend"><span><i className="gantt-legend-plan" />Date planificate consemnate</span><span><i className="gantt-legend-milestone" />Termen fără început cunoscut</span><span>Durata model P50 apare în coloană, fără poziție calendaristică.</span></div>
  </section>;
}

function BurndownView({ workspace }: { workspace: Workspace }) {
  const tasks = projectTaskRegistry(workspace);
  const completed = tasks.filter((task) => task.completed_at || isCompletedStatus(task.status));
  const completionDates = completed.map((task) => task.completed_at ? new Date(task.completed_at) : null);
  const actualHistory = completed.length > 0 && completionDates.every((date) => date && Number.isFinite(date.getTime()));
  const byDay = new Map<string, number>();
  if (actualHistory) for (const date of completionDates as Date[]) { const day = date.toISOString().slice(0, 10); byDay.set(day, (byDay.get(day) || 0) + 1); }
  const days = [...byDay.entries()].sort(([left], [right]) => left.localeCompare(right));
  const hasComparableHistory = actualHistory && days.length >= 2;
  const total = tasks.length;
  const points = hasComparableHistory ? days.map(([day, count], index) => ({ day, remaining: total - days.slice(0, index + 1).reduce((sum, item) => sum + item[1], 0) })) : [];
  const width = 680; const height = 250; const pad = 32;
  const coords = points.map((point, index) => ({ x: pad + (points.length === 1 ? 0 : index / Math.max(1, points.length - 1)) * (width - pad * 2), y: height - pad - ((total - point.remaining) / Math.max(1, total)) * (height - pad * 2) }));
  return <section className="burndown-view surface-card"><div className="burndown-heading"><div><span className="eyebrow">PROGRES RECONSTRUIT LA SCOPUL CURENT</span><h3>Burndown pe sarcini</h3><p>Folosește timestampurile completed_at. Presupune că registrul curent reprezintă un scop fix; nu reconstruiește schimbările istorice de scop.</p></div>{hasComparableHistory && <span>{points.length} zile cu finalizări</span>}</div>{hasComparableHistory ? <><div className="burndown-chart-wrap"><svg className="burndown-chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Sarcini rămase reconstruite la scopul curent, după datele de finalizare"><line x1={pad} y1={height - pad} x2={width - pad} y2={height - pad} /><line x1={pad} y1={pad} x2={pad} y2={height - pad} /><polyline points={coords.map((point) => `${point.x},${point.y}`).join(' ')} /><text x={pad} y={pad - 10}>{total} sarcini în scopul curent</text>{coords.map((point, index) => <g key={points[index].day}><circle cx={point.x} cy={point.y} r="4" /><text x={point.x} y={height - 8} textAnchor={index === points.length - 1 ? 'end' : index === 0 ? 'start' : 'middle'}>{displayDate(points[index].day)}</text><text x={point.x} y={point.y - 9} textAnchor="middle">{points[index].remaining}</text></g>)}</svg></div><p className="burndown-note">Axa Y numără sarcinile rămase. Punctele folosesc câmpurile completed_at din registrul curent fix.</p></> : <div className="burndown-empty"><strong>Nu există încă o serie comparabilă.</strong><p>Avem nevoie de date completed_at pentru toate sarcinile marcate finalizate și cel puțin două zile de finalizare. Datele din plan nu sunt progres real.</p><span>{completed.length} finalizate din {tasks.length} au timestamp valid · {days.length} zile distincte.</span></div>}</section>;
}

function PriorityView({ workspace, onSelect }: { workspace: Workspace; onSelect: (node: SelectedNode) => void }) {
  const tasks = projectTaskRegistry(workspace);
  const dependents = new Map<string, number>();
  for (const task of tasks) for (const dependencyId of task.depends_on || []) dependents.set(String(dependencyId), (dependents.get(String(dependencyId)) || 0) + 1);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const scored = tasks.map((task) => {
    const status = String(task.status || '').toLowerCase();
    const due = task.due ? new Date(task.due) : null;
    const daysLeft = due && Number.isFinite(due.getTime()) ? Math.floor((due.getTime() - today.getTime()) / 86400000) : null;
    const reasons: string[] = [];
    let score = 0;
    if (/blocked|block|waiting|wait|confirm/i.test(status)) { reasons.push(`Stare: ${titleCase(task.status || 'în așteptare')}`); score += 100; }
    if (daysLeft != null && daysLeft < 0 && !isCompletedStatus(status)) { reasons.push(`Termen depășit cu ${Math.abs(daysLeft)} zile`); score += 80; }
    else if (daysLeft != null && daysLeft <= 7 && !isCompletedStatus(status)) { reasons.push(daysLeft === 0 ? 'Termen astăzi' : `Termen în ${daysLeft} zile`); score += 50; }
    const downstream = dependents.get(task.id) || 0;
    if (downstream) { reasons.push(`${downstream} sarcini depind de aceasta`); score += downstream * 10; }
    return { task, reasons, score, downstream };
  }).sort((left, right) => right.score - left.score || left.task.title.localeCompare(right.task.title, 'ro-RO'));
  return <section className="priority-view"><div className="priority-intro"><div><strong>Priorități din semnale documentate</strong><small>Termen, stare și sarcini dependente. Nu există un câmp de prioritate declarat în surse.</small></div><span>{tasks.length} sarcini în registru</span></div>{scored.length ? <div className="priority-list">{scored.map(({ task, reasons, score }, index) => <button className="priority-task-row" key={task.id} onClick={() => onSelect({ kind: 'task', id: task.id })}><span className={'priority-rank ' + (index < 3 && score > 0 ? 'priority-rank-high' : '')}>{String(index + 1).padStart(2, '0')}</span><span className="priority-task-copy"><strong>{task.title}</strong><small>{task.owner || 'Responsabil necunoscut'} · {task.due ? `termen ${displayDate(task.due)}` : 'fără termen consemnat'}</small><span>{reasons.length ? reasons.map((reason) => <em key={reason}>{reason}</em>) : <em className="priority-neutral">Fără semnal de urgență în datele curente</em>}</span></span><StatusBadge status={task.status} /><ChevronRight size={15} /></button>)}</div> : <div className="view-empty">Nu există sarcini în registru.</div>}</section>;
}

function DiagnosticPage({ workspace, output, stored, intervention, onInterventionChange, onRecalculate, onOpenSource, onOpenTask, onExport, diagnosisMessage, diagnosing, onRunSourceDiagnosis, canRunSourceDiagnosis }: {
  workspace: Workspace; output: SimulationOutput | null; stored: boolean; intervention: SimulationIntervention | null;
  onInterventionChange: (value: SimulationIntervention | null) => void; onRecalculate: () => void;
  onOpenSource: (ref: SourceRef) => void; onOpenTask: (id: string) => void;
  onExport: (output: SimulationOutput, audience: 'client' | 'sponsor') => void;
  diagnosisMessage: string; diagnosing: boolean; onRunSourceDiagnosis: () => void; canRunSourceDiagnosis: boolean;
}) {
  const [audience, setAudience] = useState<'client' | 'sponsor'>('client');
  const [interventionKind, setInterventionKind] = useState<'duration_shift' | 'capacity'>(intervention?.kind || 'duration_shift');
  const [taskId, setTaskId] = useState(intervention?.kind === 'duration_shift' ? intervention.taskId : workspace.tasks.find((task) => !isCompletedStatus(task.status))?.id || workspace.tasks[0]?.id || '');
  const [manuallySelectedTask, setManuallySelectedTask] = useState(false);
  const [days, setDays] = useState(intervention?.kind === 'duration_shift' ? intervention.days : -1);
  const [memberId, setMemberId] = useState(intervention?.kind === 'capacity' ? intervention.memberId : workspace.members[0]?.id || '');
  const [availability, setAvailability] = useState(intervention?.kind === 'capacity' ? Math.round(intervention.availabilityFraction * 100) : 100);
  const baseline = output?.kind === 'simulation_comparison' ? output.baseline : output;
  const result = output?.kind === 'simulation_comparison' ? output.scenario : output;
  const focus = result ? [...result.tasks].sort((left, right) => right.finishDays.p90 - left.finishDays.p90)[0] : null;
  const focusRecord = focus ? workspace.tasks.find((task) => task.id === focus.taskId) : undefined;
  const affectedPath = result?.paths.find((path) => path.targetQuantile === 90) || result?.paths[0];
  const dependencyPath = (() => {
    if (!focusRecord || !affectedPath) return [];
    const pathById = new Map(affectedPath.tasks.map((task) => [task.id, task]));
    const recordById = new Map(workspace.tasks.map((task) => [task.id, task]));
    const chain: typeof affectedPath.tasks = [];
    const seen = new Set<string>();
    let cursor = focusRecord;
    while (cursor && !seen.has(cursor.id) && chain.length < 64) {
      seen.add(cursor.id);
      const point = pathById.get(cursor.id);
      if (point) chain.push(point);
      const predecessor = (cursor.depends_on || []).map((id) => ({ record: recordById.get(String(id)), point: pathById.get(String(id)) }))
        .filter((item): item is { record: ProjectRecord; point: (typeof affectedPath.tasks)[number] } => Boolean(item.record && item.point))
        .filter((item) => !point || item.point.finishDays <= point.startDays + 1e-8)
        .sort((left, right) => right.point.finishDays - left.point.finishDays)[0];
      if (!predecessor) break;
      cursor = predecessor.record;
    }
    return chain.reverse();
  })();
  const sourceRefs = focusRecord ? [...(focusRecord.field_refs ? Object.values(focusRecord.field_refs).flat() : []), ...focusRecord.source_refs] : [];
  const uniqueRefs = Array.from(new Map(sourceRefs.map((ref) => [`${ref.source_id}|${ref.location}|${ref.quote}`, ref])).values());
  const interventionValue: SimulationIntervention | null = interventionKind === 'duration_shift' && taskId && Number.isFinite(days)
    ? { kind: 'duration_shift', taskId, days, label: `${workspace.tasks.find((task) => task.id === taskId)?.title || 'Sarcină'} · ${days > 0 ? '+' : ''}${days} zile` }
    : interventionKind === 'capacity' && memberId && availability > 0 && availability <= 100
      ? { kind: 'capacity', memberId, availabilityFraction: availability / 100, label: `${workspace.members.find((member) => member.id === memberId)?.title || 'Responsabil'} · disponibilitate ${availability}%` }
      : null;
  const chooseTask = (value: string) => { setTaskId(value); const record = workspace.tasks.find((task) => task.id === value); if (record) onInterventionChange({ kind: 'duration_shift', taskId: value, days, label: `${record.title} · ${days > 0 ? '+' : ''}${days} zile` }); };
  const chooseDays = (value: number) => { setDays(value); const record = workspace.tasks.find((task) => task.id === taskId); if (record) onInterventionChange({ kind: 'duration_shift', taskId, days: value, label: `${record.title} · ${value > 0 ? '+' : ''}${value} zile` }); };
  const chooseMember = (value: string) => { setMemberId(value); const member = workspace.members.find((item) => item.id === value); if (member) onInterventionChange({ kind: 'capacity', memberId: value, availabilityFraction: availability / 100, label: `${member.title} · disponibilitate ${availability}%` }); };
  const chooseAvailability = (value: number) => { setAvailability(value); const member = workspace.members.find((item) => item.id === memberId); if (member) onInterventionChange({ kind: 'capacity', memberId, availabilityFraction: value / 100, label: `${member.title} · disponibilitate ${value}%` }); };
  useEffect(() => { if (intervention) setInterventionKind(intervention.kind); }, [intervention]);
  useEffect(() => { if (!manuallySelectedTask && focus?.taskId) setTaskId(focus.taskId); }, [focus?.taskId, manuallySelectedTask]);

  return <div className="decision-page">
    <header className="decision-page-head"><div><div className="eyebrow">PASUL 04 · DECIZII ȘI RAPOARTE</div><h1>Opțiuni și decizii</h1><p>Ce se poate schimba, ce efect ar avea în model și ce merită comunicat.</p></div><span className={'decision-save-state ' + (stored ? 'is-saved' : '')}>{stored ? 'Ultimul rezultat salvat în acest browser' : 'Rulează Monte Carlo pentru rezultate'}</span></header>
    {diagnosisMessage && <div className="diagnosis-run-feedback"><Activity size={14} />{diagnosisMessage}</div>}
    {result && focus ? <section className="decision-finding surface-card"><div className="decision-finding-kicker"><span>CONSTATAREA PRINCIPALĂ</span><span>{output?.kind === 'simulation_comparison' ? 'Comparație cu aceleași extrageri' : 'Monte Carlo · rezultat curent'}</span></div><h2>Ultima activitate în scenariul P90: {focus.title}</h2><p>{focusRecord?.description || 'Aceasta este ultima sarcină în traseul P90 din rularea curentă. Poziția din simulare nu dovedește o cauză sau o întârziere observată.'}</p><div className="decision-metric-row"><div><span>Finalizare P50</span><strong>{focus.finishDays.p50.toFixed(1)} zile</strong></div><div><span>Finalizare P90</span><strong>{focus.finishDays.p90.toFixed(1)} zile</strong></div><div><span>Durată P50</span><strong>{focus.durationDays.p50.toFixed(1)} zile</strong></div></div><div className="decision-evidence"><strong>Dovezi din proiect</strong>{uniqueRefs.length ? uniqueRefs.slice(0, 3).map((ref, index) => { const source = workspace.sources.find((item) => item.id === ref.source_id); return <button key={index} onClick={() => onOpenSource(ref)}><FileText size={13} /><span>{source?.name || 'Sursă'} · {ref.location || 'locație neînregistrată'}</span><Quote size={12} /></button>; }) : <span>Nu există citat atașat acestei sarcini.</span>}</div></section> : <section className="decision-empty surface-card"><div><strong>Nu există un rezultat de simulare salvat</strong><p>Configurează și rulează Monte Carlo. Rezultatul va apărea aici și va putea fi redeschis după reîncărcare.</p></div><button className="primary-action" onClick={onRecalculate} disabled={!interventionValue}><Activity size={14} /> Rulează prima comparație</button></section>}
    <div className="decision-analysis-grid">
      <section className="decision-path-card surface-card"><div className="decision-section-heading"><div><span className="eyebrow">DEPENDENȚE PÂNĂ LA CONSTATARE</span><h2>{affectedPath?.label || 'Traseul apare după simulare'}</h2></div><span>{affectedPath ? `${affectedPath.completionDays.toFixed(1)} zile` : 'Fără rulare'}</span></div>{dependencyPath.length ? <><div className="decision-path-list">{dependencyPath.slice(0, 5).map((task, index) => <div className="decision-path-row" key={task.id}><span className="path-sequence">{String(index + 1).padStart(2, '0')}</span><button onClick={() => onOpenTask(task.id)}><strong>{task.title}</strong><small>Începe ziua {task.startDays.toFixed(1)} · termină ziua {task.finishDays.toFixed(1)} · {task.durationDays.toFixed(1)} zile</small></button><ChevronRight size={14} /></div>)}</div>{dependencyPath.length > 5 && <details className="decision-assumptions"><summary>Deschide tot traseul ({dependencyPath.length} sarcini)</summary><div className="decision-path-list">{dependencyPath.slice(5).map((task, index) => <div className="decision-path-row" key={task.id}><span className="path-sequence">{String(index + 6).padStart(2, '0')}</span><button onClick={() => onOpenTask(task.id)}><strong>{task.title}</strong><small>Începe ziua {task.startDays.toFixed(1)} · termină ziua {task.finishDays.toFixed(1)} · {task.durationDays.toFixed(1)} zile</small></button><ChevronRight size={14} /></div>)}</div></details>}</> : <p className="decision-muted">Nu există un lanț de dependențe înregistrat până la această sarcină. Calendarul complet se vede în Simulare.</p>}</section>
      <section className="decision-missing-card surface-card"><div className="decision-section-heading"><div><span className="eyebrow">CE LIPSEȘTE DIN MODEL</span><h2>Ipoteze și date</h2></div></div>{result ? <><div className="decision-missing-row"><span>Estimări neconfirmate</span><strong>{result.missingness.placeholderEstimateTaskIds.length}</strong></div><div className="decision-missing-row"><span>Responsabili lipsă</span><strong>{result.missingness.unassignedTaskIds.length}</strong></div><div className="decision-missing-row"><span>Capacități neconfirmate</span><strong>{result.missingness.placeholderCapacityMemberIds.length}</strong></div><div className="decision-missing-row"><span>Dependențe nerezolvate</span><strong>{result.missingness.unresolvedDependencyTaskIds.length}</strong></div><details className="decision-assumptions"><summary>Formule și ipoteze</summary><ul>{result.notes.map((note, index) => <li key={index}>{note}</li>)}</ul></details></> : <p className="decision-muted">Nu presupunem estimări din lipsa unui termen. Monte Carlo va arăta intrările neconfirmate separat.</p>}</section>
    </div>
    <section className="decision-option-card surface-card"><div className="decision-section-heading"><div><span className="eyebrow">OPȚIUNE DE TESTAT</span><h2>Schimbă o intrare și compară rezultatul</h2></div><span>Propunere de model, nu modificare de proiect</span></div><div className="decision-option-controls"><label className="field-label">Tipul intervenției<select value={interventionKind} onChange={(event) => setInterventionKind(event.target.value as typeof interventionKind)}><option value="duration_shift">Ajustează durata unei sarcini</option><option value="capacity">Ajustează disponibilitatea unui responsabil</option></select></label>{interventionKind === 'duration_shift' ? <><label className="field-label">Sarcină<select value={taskId} onChange={(event) => chooseTask(event.target.value)}>{workspace.tasks.map((task) => <option key={task.id} value={task.id}>{task.title}</option>)}</select></label><label className="field-label">Schimbare în zile<input type="number" value={days} onChange={(event) => chooseDays(Number(event.target.value))} min={-30} max={30} step={0.5} /></label></> : <><label className="field-label">Responsabil<select value={memberId} onChange={(event) => chooseMember(event.target.value)}>{workspace.members.map((member) => <option key={member.id} value={member.id}>{member.title}</option>)}</select></label><label className="field-label">Disponibilitate<input type="number" value={availability} onChange={(event) => chooseAvailability(Number(event.target.value))} min={1} max={100} step={5} /><small className="field-help">Procent ipotetic pentru scenariu.</small></label></>}</div><div className="decision-option-footer"><span>{interventionValue?.label || 'Alege o intervenție validă.'}</span><button className="primary-action" onClick={() => { if (interventionValue) onInterventionChange(interventionValue); onRecalculate(); }} disabled={!interventionValue}><Activity size={14} /> {output ? 'Recalculează și compară' : 'Rulează și compară'}</button></div>{output?.kind === 'simulation_comparison' && <div className="decision-comparison-result"><strong>{output.intervention.label}</strong><span>Diferență mediană: {output.completionDeltaDays.p50.toFixed(1)} zile</span><span>Șansă de finalizare mai rapidă: {(output.probabilityOfFasterFinish * 100).toFixed(1)}%</span><small>Comparația folosește aceleași extrageri aleatorii pentru ambele scenarii.</small></div>}</section>
    <section className="decision-reports surface-card"><div className="decision-section-heading"><div><span className="eyebrow">RAPORT SEPARAT</span><h2>Alege publicul</h2></div><span>Exportă numai după verificarea citatelor și a rezultatului.</span></div><div className="report-audience-picker" role="group" aria-label="Publicul raportului"><button className={audience === 'client' ? 'report-audience-active' : ''} onClick={() => setAudience('client')}><strong>Client</strong><small>Angajamente și stare confirmate, decizii și informații lipsă.</small></button><button className={audience === 'sponsor' ? 'report-audience-active' : ''} onClick={() => setAudience('sponsor')}><strong>Sponsor</strong><small>Capacitate, impact modelat, trade-off-uri și escaladări.</small></button></div><div className="decision-report-footer"><span>{audience === 'client' ? 'Raportul exclude propunerile neacceptate.' : 'Raportul marchează explicit ipotezele și limitele simulării.'}</span><button className="quiet-button" onClick={() => { if (output) onExport(output, audience); }} disabled={!output}><Download size={14} /> Exportă raportul pentru {audience === 'client' ? 'client' : 'sponsor'}</button></div></section>
    <section className="decision-source-diagnosis"><div><strong>Analiză din surse</strong><span>{canRunSourceDiagnosis ? 'Folosește sursele procesate pentru a pregăti propuneri de risc sau decizie.' : 'Este necesar un furnizor configurat și acordul explicit pentru procesarea AI.'}</span></div><button className="quiet-button" onClick={onRunSourceDiagnosis} disabled={!canRunSourceDiagnosis || diagnosing}>{diagnosing ? <LoaderCircle size={14} className="spin" /> : <Sparkles size={14} />}{diagnosing ? 'Analizez sursele' : 'Analizează sursele'}</button></section>
  </div>;
}

function ProjectTimelineView({ workspace, onSelect }: { workspace: Workspace; onSelect: (node: SelectedNode) => void }) {
  const records = [...workspace.tasks, ...workspace.deliverables];
  const dated = records.filter((record) => scheduledValue(record)).sort((a, b) => scheduledValue(a).localeCompare(scheduledValue(b)));
  const undated = records.filter((record) => !scheduledValue(record));
  return <div className="project-timeline-view"><section className="timeline-records"><div className="section-heading"><div><h3>Date consemnate</h3><p>Planul arată numai termene prezente în surse.</p></div><span>{dated.length} elemente</span></div>{dated.map((record) => <button key={record.id} className="timeline-record" onClick={() => onSelect({ kind: record.kind === 'deliverable' ? 'deliverable' : 'task', id: record.id })}><span className="timeline-date-chip"><small>{record.due_basis === 'baseline' ? 'REF.' : 'TERMEN'}</small><strong>{new Intl.DateTimeFormat('ro-RO', { day: '2-digit', month: 'short' }).format(new Date(scheduledValue(record)))}</strong></span><span className="timeline-track"><i /></span><span className="timeline-record-copy"><strong>{record.title}</strong><small>{record.owner || 'Responsabil de confirmat'} · {titleCase(record.status || 'nespecificat')}</small></span><ChevronRight size={16} /></button>)}</section><aside className="timeline-unknown"><span className="unknown-mark"><CircleHelp size={16} /></span><div><strong>Termene încă necunoscute</strong><p>Nu completăm date prin estimare. Aceste elemente rămân fără poziție calendaristică până la confirmare.</p></div>{undated.length ? undated.map((record) => <button key={record.id} onClick={() => onSelect({ kind: record.kind === 'deliverable' ? 'deliverable' : 'task', id: record.id })}><Clock3 size={14} /><span><strong>{record.title}</strong><small>{record.owner || 'Responsabil de confirmat'}</small></span><span>Data necunoscută</span></button>) : <small>Nu sunt termene lipsă în înregistrările curente.</small>}</aside></div>;
}

function findRecord(workspace: Workspace, kind: SelectedNode extends infer _ ? string : string, id: string) {
  return kind === 'task' ? workspace.tasks.find((item) => item.id === id) || null : workspace.deliverables.find((item) => item.id === id) || null;
}

function Topology({ workspace, filter, zoom, selectedNode, onSelect }: { workspace: Workspace; filter: string; zoom: number; selectedNode: SelectedNode; onSelect: (node: SelectedNode) => void }) {
  const showMembers = filter === 'all' || filter === 'people';
  const showTasks = filter === 'all' || filter === 'tasks';
  const showDeliverables = filter === 'all' || filter === 'deliverables';
  const records = [...(showTasks ? workspace.tasks : []), ...(showDeliverables ? workspace.deliverables : [])];
  const allMembers = graphMembers(workspace);
  const members = showMembers ? allMembers : [];
  const tasks = records.filter((record) => record.kind !== 'deliverable' && !workspace.deliverables.some((item) => item.id === record.id));
  const deliverables = records.filter((record) => record.kind === 'deliverable' || workspace.deliverables.some((item) => item.id === record.id));
  const scrollRef = useRef<HTMLDivElement>(null);
  const [canvasWidth, setCanvasWidth] = useState(880);
  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const measure = () => setCanvasWidth(Math.max(880, Math.floor(element.clientWidth)));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const width = canvasWidth;
  const margin = 24;
  const laneWidth = (width - margin * 2) / 3;
  const memberWidth = Math.min(248, laneWidth - 18);
  const taskWidth = Math.min(286, laneWidth - 18);
  const deliverableWidth = Math.min(286, laneWidth - 18);
  const rows = Math.max(members.length, tasks.length, deliverables.length, 1);
  const rowStep = 116;
  const height = Math.max(475, rows * rowStep + 60);
  const memberPosition = new Map(members.map((item, index) => [String(item.id || item.title || index), { x: margin + (laneWidth - memberWidth) / 2, y: 38 + index * rowStep, w: memberWidth, h: 90 }]));
  const taskPosition = new Map(tasks.map((item, index) => [item.id, { x: margin + laneWidth + (laneWidth - taskWidth) / 2, y: 38 + index * rowStep, w: taskWidth, h: 82 }]));
  const deliverablePosition = new Map(deliverables.map((item, index) => [item.id, { x: margin + laneWidth * 2 + (laneWidth - deliverableWidth) / 2, y: 38 + index * rowStep, w: deliverableWidth, h: 82 }]));
  const getMemberId = (record: WorkspaceRecord) => {
    const assignment = workspace.assignments?.find((item) => item.record_id === record.id);
    const ownerId = record.owner_id || assignment?.member_id;
    if (ownerId) {
      const linkedMember = allMembers.find((member) => member.id === ownerId);
      if (linkedMember) return String(linkedMember.id);
    }
    const owner = record.owner?.trim().toLowerCase();
    const linkedByName = owner ? allMembers.find((member) => member.id === record.owner || member.title?.trim().toLowerCase() === owner) : undefined;
    return linkedByName ? String(linkedByName.id || linkedByName.title) : undefined;
  };
  const relatedRecordIds = new Set<string>();
  const relatedMemberIds = new Set<string>();
  if (selectedNode) {
    if (selectedNode.kind === 'member') relatedMemberIds.add(selectedNode.id);
    else relatedRecordIds.add(selectedNode.id);
    for (const item of [...workspace.tasks, ...workspace.deliverables]) {
      if (selectedNode.kind === 'member' && getMemberId(item) === selectedNode.id) relatedRecordIds.add(item.id);
    }
    for (const deliverable of workspace.deliverables) {
      if (relatedRecordIds.has(deliverable.id)) (deliverable.depends_on || []).forEach((id) => relatedRecordIds.add(String(id)));
    }
    const seeds = new Set(relatedRecordIds);
    for (const task of workspace.tasks) {
      if (seeds.has(task.id)) (task.depends_on || []).forEach((id) => relatedRecordIds.add(String(id)));
      if ((task.depends_on || []).some((id) => seeds.has(String(id)))) relatedRecordIds.add(task.id);
    }
    for (const deliverable of workspace.deliverables) {
      if ((deliverable.depends_on || []).some((id) => relatedRecordIds.has(String(id)))) relatedRecordIds.add(deliverable.id);
    }
    const linkedRecords = [...workspace.tasks, ...workspace.deliverables].filter((item) => relatedRecordIds.has(item.id));
    linkedRecords.forEach((item) => { const ownerId = getMemberId(item); if (ownerId) relatedMemberIds.add(ownerId); });
  }
  const assignmentClass = (memberId: string, recordId: string) => !selectedNode ? '' : relatedMemberIds.has(memberId) && relatedRecordIds.has(recordId) ? ' edge-focused' : ' edge-muted';
  const dependencyClass = (fromId: string, toId: string) => !selectedNode ? '' : relatedRecordIds.has(fromId) && relatedRecordIds.has(toId) ? ' edge-focused' : ' edge-muted';
  useEffect(() => {
    const scroller = scrollRef.current;
    if (!selectedNode || !scroller) return;
    const selectedElement = document.getElementById(`graph-node-${selectedNode.kind}-${selectedNode.id}`);
    if (!selectedElement || !scroller.contains(selectedElement)) return;
    const containerRect = scroller.getBoundingClientRect();
    const nodeRect = selectedElement.getBoundingClientRect();
    const top = nodeRect.top - containerRect.top + scroller.scrollTop - scroller.clientHeight / 2 + nodeRect.height / 2;
    scroller.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
  }, [selectedNode?.kind, selectedNode?.id, filter, canvasWidth, zoom]);
  return <div className="topology-scroll" ref={scrollRef}><svg className="topology" width={width} height={height} viewBox={`0 0 ${width} ${height}`} style={{ transform: `scale(${zoom / 100})`, transformOrigin: 'top left', marginBottom: `${height * (zoom / 100 - 1)}px` }}>
    <defs><marker id="arrow-muted" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="#b5c2d2" /></marker><marker id="arrow-source" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="#6f89bc" /></marker><marker id="arrow-handoff" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="#2e9d75" /></marker><marker id="arrow-approval" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="#8b62b5" /></marker>{members.filter((member) => member.avatar_asset).map((member) => { const crop = member.avatar_crop || 'top-left'; return <pattern key={member.id} id={avatarPatternId(member)} width="1" height="1" patternUnits="objectBoundingBox" patternContentUnits="objectBoundingBox"><image href={member.avatar_asset} x={crop.endsWith('right') ? -1 : 0} y={crop.startsWith('bottom') ? -1 : 0} width="2" height="2" preserveAspectRatio="none" /></pattern>; })}</defs>
    <text x={margin} y="22" className="lane-label">ECHIPĂ</text><text x={margin + laneWidth} y="22" className="lane-label">SARCINI</text><text x={margin + laneWidth * 2} y="22" className="lane-label">LIVRABILE</text>
    {[...tasks, ...deliverables].map((task) => {
      const owner = getMemberId(task); const from = owner ? memberPosition.get(String(owner)) : undefined; const to = taskPosition.get(task.id) || deliverablePosition.get(task.id);
      if (!from || !to) return null;
      return <path key={`owner-${task.id}`} className={`${task.source_refs?.length ? 'edge edge-source' : 'edge edge-derived'}${assignmentClass(String(owner), task.id)}`} d={`M ${from.x + from.w} ${from.y + from.h / 2} C ${from.x + from.w + 58} ${from.y + from.h / 2}, ${to.x - 58} ${to.y + to.h / 2}, ${to.x} ${to.y + to.h / 2}`} markerEnd={task.source_refs?.length ? 'url(#arrow-source)' : 'url(#arrow-muted)'} />;
    })}
    {tasks.flatMap((task) => (task.depends_on || []).map((dependencyId) => {
      const from = taskPosition.get(String(dependencyId)); const to = taskPosition.get(task.id);
      if (!from || !to) return null;
      const predecessor = workspace.tasks.find((item) => item.id === String(dependencyId));
      const fromOwner = predecessor ? getMemberId(predecessor) : undefined;
      const toOwner = getMemberId(task);
      const approval = /approv|review|revizu|verific/i.test(`${task.title} ${task.status || ''} ${task.description || ''}`);
      const handoff = Boolean(fromOwner && toOwner && fromOwner !== toOwner);
      const edgeKind = approval ? 'edge-approval' : handoff ? 'edge-handoff' : 'edge-derived';
      const marker = approval ? 'url(#arrow-approval)' : handoff ? 'url(#arrow-handoff)' : 'url(#arrow-muted)';
      return <path key={`dep-${dependencyId}-${task.id}`} className={`edge ${edgeKind}${dependencyClass(String(dependencyId), task.id)}`} d={`M ${from.x + from.w} ${from.y + from.h / 2} C ${from.x + from.w + 58} ${from.y + from.h / 2}, ${to.x - 58} ${to.y + to.h / 2}, ${to.x} ${to.y + to.h / 2}`} markerEnd={marker} />;
    }))}
    {deliverables.flatMap((deliverable) => (deliverable.depends_on || []).map((dependencyId) => {
      const from = taskPosition.get(String(dependencyId)) || deliverablePosition.get(String(dependencyId)); const to = deliverablePosition.get(deliverable.id);
      if (!from || !to) return null;
      const predecessor = [...workspace.tasks, ...workspace.deliverables].find((item) => item.id === String(dependencyId));
      const fromOwner = predecessor ? getMemberId(predecessor) : undefined;
      const toOwner = getMemberId(deliverable);
      const approval = /approv|review|revizu|verific/i.test(`${deliverable.title} ${deliverable.status || ''} ${deliverable.description || ''}`);
      const handoff = Boolean(fromOwner && toOwner && fromOwner !== toOwner);
      const edgeKind = approval ? 'edge-approval' : handoff ? 'edge-handoff' : 'edge-derived';
      const marker = approval ? 'url(#arrow-approval)' : handoff ? 'url(#arrow-handoff)' : 'url(#arrow-muted)';
      return <path key={`deliverable-${dependencyId}-${deliverable.id}`} className={`edge ${edgeKind}${dependencyClass(String(dependencyId), deliverable.id)}`} d={`M ${from.x + from.w} ${from.y + from.h / 2} C ${from.x + from.w + 45} ${from.y + from.h / 2}, ${to.x - 45} ${to.y + to.h / 2}, ${to.x} ${to.y + to.h / 2}`} markerEnd={marker} />;
    }))}
    {members.map((member, index) => {
      const id = String(member.id || member.title || index); const pos = memberPosition.get(id)!; const name = String(member.title || 'Unnamed owner');
      return <g id={`graph-node-member-${id}`} key={id} className={`graph-node person-node ${selectedNode?.kind === 'member' && selectedNode.id === id ? 'node-selected' : ''}${selectedNode && !relatedMemberIds.has(id) ? ' node-muted' : ''}`} onClick={() => onSelect({ kind: 'member', id })} role="button" tabIndex={0} aria-pressed={selectedNode?.kind === 'member' && selectedNode.id === id} aria-label={`Open ${name}`} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect({ kind: 'member', id }); } }}>
        <rect x={pos.x} y={pos.y} width={pos.w} height={pos.h} rx="12" /><circle cx={pos.x + 26} cy={pos.y + 30} r="21" className="person-avatar-circle" style={member.avatar_asset ? { fill: `url(#${avatarPatternId(member)})` } : undefined} />{!member.avatar_asset && <text x={pos.x + 26} y={pos.y + 35} className="person-initials">{name.slice(0, 1).toUpperCase()}</text>}<text x={pos.x + 56} y={pos.y + 27} className="node-title">{truncate(name, 20)}</text><text x={pos.x + 56} y={pos.y + 50} className="node-subtitle">{truncate(String(member.role || 'Rol nespecificat'), 24)}</text><text x={pos.x + 56} y={pos.y + 72} className="node-meta">{titleCase(member.member_type || 'unspecified').toUpperCase()}{String(member.id || '').startsWith('owner:') ? ' · RESPONSABIL NOMINAL' : member.member_type === 'person' ? ' · MEMBRU AL ECHIPEI' : ''}</text>
      </g>;
    })}
    {tasks.map((task) => <RecordNode key={`task-${task.id}`} record={task} kind="task" pos={taskPosition.get(task.id)!} selected={selectedNode?.kind === 'task' && selectedNode.id === task.id} related={!selectedNode || relatedRecordIds.has(task.id)} onSelect={onSelect} />)}
    {deliverables.map((record) => <RecordNode key={`deliverable-${record.id}`} record={record} kind="deliverable" pos={deliverablePosition.get(record.id)!} selected={selectedNode?.kind === 'deliverable' && selectedNode.id === record.id} related={!selectedNode || relatedRecordIds.has(record.id)} onSelect={onSelect} />)}
    {!members.length && !tasks.length && !deliverables.length && <text x={width / 2} y="240" textAnchor="middle" className="empty-graph-text">{workspace.proposals.some((proposal) => proposal.status === 'proposed') ? 'Revizuiește propunerile pentru a adăuga elementele acceptate aici' : workspace.sources.length ? 'Nu există încă elemente acceptate în hartă' : 'Adaugă documente pentru a construi harta proiectului'}</text>}
  </svg></div>;
}

function RecordNode({ record, kind, pos, selected, related, onSelect }: { record: WorkspaceRecord; kind: 'task' | 'deliverable'; pos: { x: number; y: number; w: number; h: number }; selected: boolean; related: boolean; onSelect: (node: SelectedNode) => void }) {
  return <g id={`graph-node-${kind}-${record.id}`} className={`graph-node record-node ${kind === 'deliverable' ? 'deliverable-node' : ''} ${selected ? 'node-selected' : ''}${related ? '' : ' node-muted'}`} onClick={() => onSelect({ kind, id: record.id })} role="button" tabIndex={0} aria-pressed={selected} aria-label={`Open ${getRecordName(record)}`} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect({ kind, id: record.id }); } }}>
    <rect x={pos.x} y={pos.y} width={pos.w} height={pos.h} rx="12" /><rect x={pos.x + 13} y={pos.y + 14} width="5" height="54" rx="2.5" className={record.status && /block|wait|confirm/i.test(record.status) ? 'node-status-blocked' : 'node-status-default'} /><text x={pos.x + 31} y={pos.y + 27} className="node-title">{truncate(getRecordName(record), 28)}</text><text x={pos.x + 31} y={pos.y + 48} className="node-subtitle">{truncate(record.owner || 'Responsabil necunoscut', 17)} · {truncate(scheduledLabel(record), 22)}</text><text x={pos.x + 31} y={pos.y + 68} className="node-meta">{titleCase(record.status || 'unreviewed')} · {kind === 'task' ? 'SARCINĂ' : 'LIVRABIL'}</text>
  </g>;
}

function RecordList({ workspace, filter, onSelect }: { workspace: Workspace; filter: string; onSelect: (node: SelectedNode) => void }) {
  const records = [
    ...(filter === 'all' || filter === 'people' ? graphMembers(workspace).map((member, index) => ({ id: String(member.id || member.title || index), title: String(member.title || 'Unnamed owner'), subtitle: String(member.role || 'Role not recorded'), kind: 'member' as const, memberType: member.member_type, state: '' })) : []),
    ...(filter === 'all' || filter === 'tasks' ? workspace.tasks.map((record) => ({ id: record.id, title: getRecordName(record), subtitle: `${record.owner || 'Owner unknown'} · ${scheduledLabel(record)}`, kind: 'task' as const, memberType: undefined, state: String(record.status || 'Unreviewed') })) : []),
    ...(filter === 'all' || filter === 'deliverables' ? workspace.deliverables.map((record) => ({ id: record.id, title: getRecordName(record), subtitle: `${record.owner || 'Owner unknown'} · ${scheduledLabel(record)}`, kind: 'deliverable' as const, memberType: undefined, state: String(record.status || 'Unreviewed') })) : []),
  ];
  return <div className="record-list-view">{records.length ? records.map((item) => <button className="record-list-row" key={`${item.kind}-${item.id}`} onClick={() => onSelect({ kind: item.kind, id: item.id })}><span className={`list-record-icon ${item.kind}`}>{item.kind === 'member' ? <Users size={15} /> : item.kind === 'task' ? <GitBranch size={15} /> : <FileCheck2 size={15} />}</span><span className="record-list-copy"><strong>{item.title}</strong><small>{item.subtitle}</small></span>{item.kind === 'member' ? <span className="actor-type-badge">{titleCase(item.memberType || 'unspecified')}</span> : <StatusBadge status={item.state} />}<ChevronRight size={16} /></button>) : <EmptyMap pendingProposals={workspace.proposals.filter((proposal) => proposal.status === 'proposed').length} hasSources={workspace.sources.length > 0} />}</div>;
}

function graphMembers(workspace: Workspace): ProjectRecord[] {
  const people = [...workspace.members];
  const known = new Set(people.flatMap((member) => [member.id, member.title].filter(Boolean).map((value) => String(value).trim().toLowerCase())));
  const records = [...workspace.tasks, ...workspace.deliverables];
  const owners = Array.from(new Set(records.map((record) => record.owner?.trim()).filter((owner): owner is string => Boolean(owner))));
  for (const owner of owners) {
    if (known.has(owner.toLowerCase())) continue;
    const citedBy = records.find((record) => record.owner === owner);
    people.push({ id: `owner:${owner}`, kind: 'member', title: owner, role: 'Named as an owner in a task', member_type: 'unknown', status: null, owner: null, due: null, depends_on: [], source_refs: citedBy?.source_refs || [], evidence_state: citedBy?.evidence_state || 'not_found', review_state: citedBy?.review_state || 'unreviewed', created_at: citedBy?.created_at || '', updated_at: citedBy?.updated_at || '' });
    known.add(owner.toLowerCase());
  }
  return people;
}

function EmptyMap({ pendingProposals, hasSources }: { pendingProposals: number; hasSources: boolean }) { return <div className="map-empty"><Network size={22} /><strong>{pendingProposals ? 'Propunerile așteaptă revizuirea ta' : hasSources ? 'Nu există încă elemente acceptate în hartă' : 'Harta proiectului este goală'}</strong><p>{pendingProposals ? 'Deschide citatele și aprobă schimbările potrivite. Harta activă se actualizează după aprobare.' : hasSources ? 'Mai adaugă surse sau înregistrează o sarcină ori un livrabil.' : 'Adaugă documente, iar TeamCreator va pregăti o hartă de verificat.'}</p></div>; }

function SourceInventoryBanner({ pendingProposals, reviewedProposals, onReview, onRetry, onCreateManual, retrying, retryResult }: { pendingProposals: number; reviewedProposals: number; onReview: () => void; onRetry: () => void; onCreateManual: () => void; retrying: boolean; retryResult: string }) {
  if (pendingProposals > 0) return <div className="source-inventory-banner proposal-ready-banner"><span className="inventory-icon"><FileCheck2 size={16} /></span><div><strong>{pendingProposals} {pendingProposals === 1 ? 'propunere gata de revizuire' : 'propuneri gata de revizuire'}</strong><p>Schimbările cu citate așteaptă decizia ta. Verifică sursele înainte să le adaugi în harta activă.</p></div><div className="inventory-actions"><button className="primary-action" onClick={onReview}>Revizuiește propunerile <ArrowRight size={13} /></button></div></div>;
  if (reviewedProposals > 0) return <div className="source-inventory-banner proposal-ready-banner"><span className="inventory-icon"><FileCheck2 size={16} /></span><div><strong>Nu sunt elemente acceptate pe hartă</strong><p>{reviewedProposals} {reviewedProposals === 1 ? 'propunere a fost' : 'propuneri au fost'} revizuite, dar nicio sarcină sau livrabil nu este în harta activă.</p></div><div className="inventory-actions"><button className="quiet-button" onClick={onReview}>Vezi istoricul revizuirii</button><button className="primary-action" onClick={onCreateManual}><Plus size={13} /> Adaugă element</button></div></div>;
  const message = retrying ? 'Analiza continuă asupra surselor salvate. Proiectul rămâne neschimbat până la finalizare.' : retryResult || 'Sursele sunt salvate, dar nu s-au extras fapte de proiect. Reia procesarea sau adaugă manual o sarcină ori un livrabil.';
  return <div className="source-inventory-banner"><span className="inventory-icon">{retrying ? <LoaderCircle size={16} className="spin" /> : <AlertCircle size={16} />}</span><div><strong>{retrying ? 'Analiză în curs' : 'Doar inventar de surse'}</strong><p>{message}</p></div><div className="inventory-actions"><button className="quiet-button" onClick={onRetry} disabled={retrying}>{retrying ? <LoaderCircle size={14} className="spin" /> : <Activity size={14} />}{retrying ? 'Reiau analiza' : 'Reia extragerea'}</button><button className="primary-action" onClick={onCreateManual}><Plus size={14} /> Adaugă element</button></div></div>;
}

function truncate(value: string, length: number) { return value.length > length ? `${value.slice(0, length - 1)}…` : value; }
function avatarPatternId(member: ProjectRecord) { return `avatar-${String(member.id).replace(/[^a-zA-Z0-9_-]/g, '-')}`; }

function RecordInspector({ workspace, node, record, onClose, onSelect, onOpenSource, onSave, impact, impactLoading, impactError }: {
  workspace: Workspace; node: NonNullable<SelectedNode>; record: WorkspaceRecord | null; onClose: () => void;
  onSelect: (node: SelectedNode) => void;
  onOpenSource: (ref: SourceRef) => void;
  onSave: (kind: string, id: string, fields: Record<string, unknown>) => Promise<void>; impact: any; impactLoading: boolean; impactError: string;
}) {
  const member = node.kind === 'member' ? graphMembers(workspace).find((item) => item.id === node.id || item.title === node.id) : null;
  const target = record || member || null;
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [localError, setLocalError] = useState('');
  const [title, setTitle] = useState(target?.title || '');
  const [owner, setOwner] = useState(target?.owner || '');
  const [due, setDue] = useState((target?.due || '').slice(0, 10));
  const [status, setStatus] = useState(target?.status || '');
  const [reason, setReason] = useState('');
  const [redistributeTaskId, setRedistributeTaskId] = useState('');
  const [redistributeMemberId, setRedistributeMemberId] = useState('');
  const [assignmentReason, setAssignmentReason] = useState('');
  const [dependencies, setDependencies] = useState<string[]>(target?.depends_on || []);
  const [resolvedDependencyLinks, setResolvedDependencyLinks] = useState<Record<string, string>>({});
  const unresolvedDependencies: string[] = Array.isArray((target as any)?.unresolved_dependencies) ? (target as any).unresolved_dependencies.map(String) : [];
  const linkedSourceRefs = target?.source_refs || [];
  const ownerOptions = graphMembers(workspace).filter((person) => Boolean(person.title));
  const memberWork = member ? [...workspace.tasks, ...workspace.deliverables].filter((item) => {
    const assigned = workspace.assignments?.some((assignment) => assignment.record_id === item.id && assignment.member_id === member.id);
    return item.owner_id === member.id || assigned || item.owner?.trim().toLocaleLowerCase() === member.title?.trim().toLocaleLowerCase();
  }).sort((a, b) => scheduledValue(a).localeCompare(scheduledValue(b))) : [];
  const memberHandoffs = member ? workflowHandoffs(workspace).filter((item) => item.fromMember.id === member.id || item.toMember.id === member.id) : [];
  const memberDecisions = member ? workspace.decisions.filter((item) => item.owner_id === member.id || item.owner?.trim().toLocaleLowerCase() === member.title?.trim().toLocaleLowerCase()) : [];

  const toggleDependency = (id: string) => {
    const removing = dependencies.includes(id);
    setDependencies((current) => removing ? current.filter((value) => value !== id) : [...current, id]);
    if (removing) setResolvedDependencyLinks((links) => Object.fromEntries(Object.entries(links).filter(([, dependencyId]) => dependencyId !== id)));
  };
  const mapUnresolvedDependency = (label: string, dependencyId: string) => {
    setResolvedDependencyLinks((current) => {
      const next = { ...current };
      if (dependencyId) next[label] = dependencyId;
      else delete next[label];
      return next;
    });
    if (dependencyId) setDependencies((current) => current.includes(dependencyId) ? current : [...current, dependencyId]);
  };
  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!record || node.kind === 'member') return;
    setSaving(true); setLocalError('');
    try {
      const resolvedLinks = Object.entries(resolvedDependencyLinks).filter(([, dependencyId]) => dependencies.includes(dependencyId)).map(([label, dependency_id]) => ({ label, dependency_id }));
      await onSave(node.kind, record.id, { title, owner: owner || null, due: due || null, status: status || null, depends_on: dependencies, resolved_dependency_links: resolvedLinks, reason: reason.trim() || undefined });
      setEditing(false); setReason(''); setResolvedDependencyLinks({});
    } catch (error: any) { setLocalError(error.message || 'Could not save this edit.'); }
    finally { setSaving(false); }
  };

  return <aside className="inspector-panel">
    <div className="inspector-header"><span className="inspector-kind">{node.kind === 'member' ? 'PERSOANĂ / ROL' : node.kind.toUpperCase()}</span><button className="icon-button" aria-label="Închide detaliile" onClick={onClose}><X size={17} /></button></div>
    {!target ? <div className="inspector-unavailable">This item is no longer in the current project model.</div> : <>
      <div className="inspector-title-block"><h2>{getRecordName(target)}</h2><div className="inspector-status-line">{node.kind !== 'member' && <StatusBadge status={target.status} />}<EvidenceBadge state={target.evidence_state} /><span className="review-state">{titleCase(target.review_state)}</span></div></div>
      {record && node.kind !== 'member' && !editing && <button className="edit-record-button" onClick={() => setEditing(true)}><Settings2 size={15} /> Edit project record</button>}
      {editing && record ? <form className="record-edit-form" onSubmit={save}>
        <label className="field-label">Name or title<input value={title} onChange={(event) => setTitle(event.target.value)} required /></label>
        <label className="field-label">Owner<select value={owner} onChange={(event) => setOwner(event.target.value)}><option value="">Unknown</option>{ownerOptions.map((person) => <option key={person.id} value={person.title || ''}>{person.title} · {titleCase(person.member_type || 'unspecified')}</option>)}</select></label>
        <label className="field-label">Current due date<input type="date" value={due} onChange={(event) => setDue(event.target.value)} /></label>
        <label className="field-label">Current status<select value={status} onChange={(event) => setStatus(event.target.value)}><option value="">Unknown</option>{status && !['not_started', 'in_progress', 'blocked', 'complete', 'accepted', 'proposed'].includes(status) && <option value={status}>{titleCase(status)}</option>}{['not_started', 'in_progress', 'blocked', 'complete', 'accepted', 'proposed'].map((item) => <option key={item} value={item}>{titleCase(item)}</option>)}</select></label>
        {unresolvedDependencies.length > 0 && <div className="unresolved-link-editor"><div className="field-label">Unlinked dependency references<small className="field-help">Choose a task for each reference you can resolve. Unselected references stay open.</small></div>{unresolvedDependencies.map((label) => { const refs = dependencyEvidence(record, label); return <div className="unresolved-link-row" key={label}><div><strong>{unresolvedDependencyLabel(label, workspace)}</strong>{refs.length ? <EvidenceList refs={refs} sources={workspace.sources} compact onOpenSource={onOpenSource} /> : <small className="field-help">No exact source quote is attached to this reference.</small>}</div><label className="field-label">Link to<select value={resolvedDependencyLinks[label] || ''} onChange={(event) => mapUnresolvedDependency(label, event.target.value)}><option value="">Leave unlinked</option>{workspace.tasks.filter((task) => task.id !== record.id).map((task) => <option key={task.id} value={task.id}>{task.title}</option>)}</select></label></div>; })}</div>}
        <div className="field-label">Depends on <small className="field-help">Choose tasks that must be completed first.</small></div>
        <div className="dependency-options">{workspace.tasks.filter((item) => item.id !== record.id).map((task) => <label key={task.id}><input type="checkbox" checked={dependencies.includes(task.id)} onChange={() => toggleDependency(task.id)} /><span>{task.title}</span></label>)}</div>
        <label className="field-label">Reason for this correction <input value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Optional note for the history" /></label>
        {localError && <p className="field-error">{localError}</p>}
        <div className="edit-actions"><button type="button" className="quiet-button" onClick={() => setEditing(false)}>Cancel</button><button type="submit" className="primary-action" disabled={saving}>{saving ? <LoaderCircle size={15} className="spin" /> : <Check size={15} />} Save edit</button></div>
      </form> : <>
        <div className="inspector-facts">{node.kind === 'member' ? <><Fact label="Tip de rol" value={titleCase(target.member_type || 'nespecificat')} unknown={!target.member_type || target.member_type === 'unknown'} /><Fact label={String(target.id).startsWith('owner:') ? 'Relație' : 'Rol în proiect'} value={target.role || 'Rol neînregistrat'} unknown={!target.role} /><Fact label="Competențe înregistrate" value={target.documented_skills?.length ? target.documented_skills.join(', ') : 'Necunoscute'} unknown={!target.documented_skills?.length} /><Fact label="Disponibilitate" value={target.availability_note || 'Neconfirmată'} unknown={!target.availability_note} /></> : <><Fact label="Responsabil" value={target.owner || 'Necunoscut'} unknown={!target.owner} /><Fact label="Termen curent" value={target.due ? displayDate(target.due) : 'Fără dată înregistrată'} unknown={!target.due} /><Fact label="Termen de bază acceptat" value={target.baseline_due ? displayDate(target.baseline_due) : 'Neînregistrat'} unknown={!target.baseline_due} /><Fact label="Prognoză curentă" value={target.current_forecast ? displayDate(target.current_forecast) : 'Neînregistrată'} unknown={!target.current_forecast} /></>}</div>
        {target.description && <div className="inspector-description"><div className="detail-label">Description</div><p>{target.description}</p></div>}
        {member && <>
          <section className="inspector-section member-profile-section"><div className="detail-section-title"><Users size={15} /><span>Sarcini alocate</span><span className="section-count">{memberWork.length}</span></div>{memberWork.length ? <div className="member-work-list">{memberWork.map((item) => <button type="button" className="member-work-row" key={item.id} onClick={() => onSelect({ kind: item.kind === 'deliverable' ? 'deliverable' : 'task', id: item.id })}><span><strong>{item.title}</strong><small>{titleCase(item.status || 'Stare nespecificată')} · {item.due ? displayDate(item.due) : 'Fără termen'}</small></span><span className="member-work-metrics">{item.planned_duration_days != null ? `${item.planned_duration_days} zile` : 'durată ?'}{item.effort_hours != null ? ` · ${item.effort_hours} h` : ''}</span><ChevronRight size={14} /></button>)}</div> : <p className="muted-small">Nu sunt sarcini asociate explicit acestei persoane.</p>}</section>
          <section className="inspector-section member-profile-section"><div className="detail-section-title"><ArrowRight size={15} /><span>Predări observate</span><span className="section-count">{memberHandoffs.length}</span></div>{memberHandoffs.length ? <div className="member-handoff-list">{memberHandoffs.map((item) => <button type="button" className="member-handoff-row" key={item.id} onClick={() => onSelect({ kind: 'task', id: item.next.id })}><span>{item.fromMember.title}</span><ArrowRight size={13} /><strong>{item.toMember.title}</strong><small>{item.previous.title} → {item.next.title}</small></button>)}</div> : <p className="muted-small">Nicio predare între responsabili nu este înregistrată.</p>}</section>
          <section className="inspector-section member-profile-section"><div className="detail-section-title"><Check size={15} /><span>Decizii și aprobări</span><span className="section-count">{memberDecisions.length}</span></div>{memberDecisions.length ? <div className="member-decision-list">{memberDecisions.map((item) => <article key={item.id}><strong>{item.title}</strong><small>{titleCase(item.status || 'Stare nespecificată')}</small>{item.source_refs?.length ? <EvidenceList refs={item.source_refs} sources={workspace.sources} compact onOpenSource={onOpenSource} /> : <p className="muted-small">Nu este atașat un citat pentru această decizie.</p>}</article>)}</div> : <p className="muted-small">Nu există o decizie sau aprobare asociată explicit acestei persoane.</p>}</section>
          <details className="member-redistribute"><summary><Users size={14} /> Reasignează o sarcină alocată</summary><div className="member-redistribute-fields"><label className="field-label">Sarcină<select value={redistributeTaskId} onChange={(event) => setRedistributeTaskId(event.target.value)}><option value="">Alege o sarcină</option>{memberWork.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}</select></label><label className="field-label">Noul responsabil<select value={redistributeMemberId} onChange={(event) => setRedistributeMemberId(event.target.value)}><option value="">Alege un coleg</option>{ownerOptions.filter((person) => person.id !== member.id).map((person) => <option key={person.id} value={person.id}>{person.title} · {titleCase(person.role || person.member_type || 'rol nespecificat')}</option>)}</select></label><label className="field-label">Motiv consemnat<input value={assignmentReason} onChange={(event) => setAssignmentReason(event.target.value)} placeholder="Decizie confirmată de manager" /></label><button type="button" className="primary-action" disabled={!redistributeTaskId || !redistributeMemberId || !assignmentReason.trim() || saving} onClick={async () => { const item = memberWork.find((candidate) => candidate.id === redistributeTaskId); const nextOwner = ownerOptions.find((candidate) => candidate.id === redistributeMemberId); if (!item || !nextOwner) return; setSaving(true); setLocalError(''); try { await onSave(item.kind === 'deliverable' ? 'deliverable' : 'task', item.id, { owner: nextOwner.title, reason: assignmentReason.trim() }); setAssignmentReason(''); setRedistributeTaskId(''); setRedistributeMemberId(''); } catch (error: any) { setLocalError(error.message || 'Nu s-a putut salva realocarea.'); } finally { setSaving(false); } }}>{saving ? <LoaderCircle size={14} className="spin" /> : <Check size={14} />} Aplică realocarea</button>{localError && <p className="field-error">{localError}</p>}</div></details>
        </>}
        {node.kind !== 'member' && <div className="inspector-section"><div className="detail-section-title"><GitBranch size={15} /><span>Dependențe</span><span className="section-count">{target.depends_on.length + unresolvedDependencies.length}</span></div>{target.depends_on.map((dependency) => { const linked = [...workspace.tasks, ...workspace.deliverables].find((item) => item.id === dependency); return <div className="dependency-item" key={dependency}><span className="dependency-arrow"><ArrowDownRight size={14} /></span><span><strong>{linked?.title || 'Elementul legat nu mai există'}</strong><small>De finalizat înainte de acest element</small></span></div>; })}{unresolvedDependencies.map((label) => { const refs = dependencyEvidence(target, label); return <div className="dependency-item dependency-unresolved" key={`unresolved-${label}`}><span className="dependency-arrow"><AlertTriangle size={14} /></span><span><strong>Legătură nerezolvată · {unresolvedDependencyLabel(label, workspace)}</strong><small>Referința din sursă nu este legată. Editează înregistrarea numai dacă poți confirma dependența.</small>{refs.length ? <EvidenceList refs={refs} sources={workspace.sources} compact onOpenSource={onOpenSource} /> : <small className="muted-small">Nu este atașat un citat exact.</small>}</span></div>; })}{!target.depends_on.length && !unresolvedDependencies.length && <p className="muted-small">Nicio dependență înregistrată.</p>}</div>}
      </>}
      {node.kind === 'task' && <div className="inspector-section impact-section"><div className="detail-section-title"><ArrowRight size={15} /><span>Downstream impact</span><span className="calculated-tag">Calculated</span></div>{impactLoading ? <div className="impact-loading"><LoaderCircle size={14} className="spin" /> Following dependency paths…</div> : impactError ? <p className="field-error">{impactError}</p> : <>{impact?.graph?.has_cycles && <div className="cycle-warning"><AlertTriangle size={14} /><span>{impact.warning || 'A dependency cycle interrupts some paths. Other dependency paths are still shown below.'}</span></div>}{impact?.paths?.length ? impact.paths.map((path: any, index: number) => <div className="impact-path" key={`${path.affected_id || index}`}><p>{path.explanation || 'This task is linked to downstream project work.'}</p><div className="impact-chain"><span>{path.from_title || target.title}</span>{(path.via || []).map((step: any) => <React.Fragment key={step.id}><ChevronRight size={12} /><span>{step.title}</span></React.Fragment>)}<ChevronRight size={12} /><strong>{path.affected_title}</strong></div><EvidenceList refs={path.source_refs || []} sources={workspace.sources} compact onOpenSource={onOpenSource} /></div>) : <p className="muted-small">No downstream impact path is recorded for this task.</p>}</>}</div>}
      <div className="inspector-section evidence-section"><div className="detail-section-title"><Quote size={15} /><span>Dovezi din surse</span><span className="section-count">{linkedSourceRefs.length}</span></div>{linkedSourceRefs.length ? <EvidenceList refs={linkedSourceRefs} sources={workspace.sources} onOpenSource={onOpenSource} /> : <div className="no-evidence"><CircleHelp size={15} /><span>Această înregistrare nu are un citat atașat. Necesită verificare.</span></div>}</div>
    </>}
  </aside>;
}

function Fact({ label, value, unknown }: { label: string; value: string; unknown?: boolean }) {
  return <div className="fact-row"><span>{label}</span><strong className={unknown ? 'fact-unknown' : ''}>{value}</strong></div>;
}

function EvidenceBadge({ state }: { state: unknown }) {
  const value = String(state || 'not_found');
  return <span className={`evidence-badge evidence-${value}`}>{titleCase(value)}</span>;
}

function EvidenceList({ refs, sources, compact = false, onOpenSource }: { refs: SourceRef[]; sources: Source[]; compact?: boolean; onOpenSource?: (ref: SourceRef) => void }) {
  return <div className={`evidence-list ${compact ? 'evidence-compact' : ''}`}>{refs.map((ref, index) => {
    const source = sources.find((item) => item.id === ref.source_id);
    return <div className="evidence-quote" key={`${ref.source_id}-${index}`}><div className="quote-topline"><span className="quote-source-name"><FileText size={13} /><strong>{source?.name || 'Sursă indisponibilă'}</strong><span>{ref.location || 'Locație neînregistrată'}</span></span>{onOpenSource && source && <button type="button" className="quote-open-source" onClick={() => onOpenSource(ref)} aria-label={`Deschide ${source.name} la ${ref.location || 'citat'}`}>Deschide sursa <ArrowUpRight size={12} /></button>}</div>{ref.quote ? <blockquote>„{ref.quote}”</blockquote> : <p className="muted-small">Nu este salvat un citat exact pentru această referință.</p>}</div>;
  })}</div>;
}

type SourceCategory = 'contract' | 'plan' | 'meetings' | 'other';
const sourceCategories: Array<{ id: SourceCategory; label: string; hint: string }> = [
  { id: 'contract', label: 'Contract', hint: 'Domeniu, angajamente și aprobare' },
  { id: 'plan', label: 'Plan', hint: 'Sarcini, responsabili și termene' },
  { id: 'meetings', label: 'Ședințe', hint: 'Decizii, predări și actualizări' },
  { id: 'other', label: 'Alte surse', hint: 'Restul fișierelor proiectului' },
];

function sourceCategory(source: Source): SourceCategory {
  const name = `${source.relative_path || ''} ${source.name}`.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  if (/contract|agreement|tor\b|terms|accord|legal|scope/.test(name)) return 'contract';
  if (/plan|schedule|roadmap|task|deliverable|registr|calendar|baseline/.test(name)) return 'plan';
  if (/meeting|sedint|sedinta|minutes|check.?in|interview|call|stenogram/.test(name)) return 'meetings';
  return 'other';
}

function SourcesPage({ workspace, onAdd, onOpenRecord, onReview, focusSourceId, focusRef, onClearFocus, onRetry, retrying, retryResult, provider }: { workspace: Workspace; onAdd: () => void; onOpenRecord: (kind: 'member' | 'task' | 'deliverable', id: string) => void; onReview: () => void; focusSourceId: string; focusRef: SourceRef | null; onClearFocus: () => void; onRetry: (sourceIds?: string[], options?: { reprocess?: boolean }) => void; retrying: boolean; retryResult: string; provider?: Record<string, unknown> | null }) {
  const [openId, setOpenId] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<SourceCategory>('contract');
  const [manuallySelectedCategory, setManuallySelectedCategory] = useState(false);
  const [focusWindow, setFocusWindow] = useState<SourceQuoteWindow | null>(null);
  const [focusWindowLoading, setFocusWindowLoading] = useState(false);
  const [focusWindowError, setFocusWindowError] = useState('');
  const rowRefs = useRef(new Map<string, HTMLDivElement>());
  useEffect(() => {
    setManuallySelectedCategory(false);
    const firstPopulated = sourceCategories.find((category) => workspace.sources.some((source) => sourceCategory(source) === category.id));
    setSelectedCategory(firstPopulated?.id || 'contract');
  }, [workspace.project.id]);
  useEffect(() => {
    if (manuallySelectedCategory || workspace.sources.some((source) => sourceCategory(source) === selectedCategory)) return;
    const firstPopulated = sourceCategories.find((category) => workspace.sources.some((source) => sourceCategory(source) === category.id));
    if (firstPopulated) setSelectedCategory(firstPopulated.id);
  }, [workspace.sources, selectedCategory, manuallySelectedCategory]);
  useEffect(() => { if (focusSourceId) setOpenId(focusSourceId); }, [focusSourceId, focusRef?.quote]);
  useEffect(() => {
    if (!focusRef?.quote) { setFocusWindow(null); setFocusWindowError(''); return; }
    let live = true;
    setFocusWindow(null); setFocusWindowError(''); setFocusWindowLoading(true);
    api<SourceQuoteWindow>(`/projects/${encodeURIComponent(workspace.project.id)}/sources/${encodeURIComponent(focusRef.source_id)}/quote?quote=${encodeURIComponent(focusRef.quote)}&location=${encodeURIComponent(focusRef.location || '')}`)
      .then((result) => { if (live) setFocusWindow(result); })
      .catch((reason: any) => { if (live) setFocusWindowError(reason.message || 'Could not open the cited text window.'); })
      .finally(() => { if (live) setFocusWindowLoading(false); });
    return () => { live = false; };
  }, [workspace.project.id, focusRef?.source_id, focusRef?.quote]);
  useEffect(() => {
    if (focusSourceId && openId === focusSourceId) rowRefs.current.get(focusSourceId)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [focusSourceId, openId]);
  const parsed = workspace.sources.filter((source) => source.parser_status === 'parsed').length;
  const failed = workspace.sources.filter((source) => ['failed', 'unsupported', 'empty'].includes(source.parser_status)).length;
  const continuingSources = workspace.sources.filter((source) => getSourceCoverage(source).canContinue);
  const retryableSources = workspace.sources.filter((source) => getSourceCoverage(source).canRetry);
  const remainingSegments = continuingSources.reduce((count, source) => count + (getSourceCoverage(source).remaining || 0), 0);
  const recordsWithEvidence = [...workspace.members, ...workspace.tasks, ...workspace.deliverables, ...workspace.risks, ...workspace.decisions].filter((record) => record.source_refs.length > 0);
  const pendingCitedItems = workspace.proposals.filter((proposal) => proposal.status === 'proposed').flatMap((proposal) => proposal.items.filter((item) => item.review_state !== 'manager_confirmed' && item.source_refs.length > 0));
  const validatedCitedRecords = recordsWithEvidence.filter((record) => record.review_state === 'manager_confirmed' || record.review_state === 'manager_corrected').length;
  const filteredSources = workspace.sources.filter((source) => sourceCategory(source) === selectedCategory);
  const aiAvailable = provider?.provider !== 'none' && provider?.mode !== 'degraded';
  return <div className="sources-page">
    <div className="context-lifecycle" aria-label="Starea surselor și afirmațiilor"><div><strong>{workspace.sources.length}</strong><span>Încărcate</span></div><i /><div><strong>{parsed}</strong><span>Text citit</span></div><i /><div><strong>{recordsWithEvidence.length + pendingCitedItems.length}</strong><span>Afirmații cu sursă</span></div><i /><div><strong>{validatedCitedRecords}</strong><span>Înregistrări acceptate</span></div>{failed > 0 && <small>{failed} fișiere necesită atenție</small>}</div>
    <div className="source-checklist-grid">{sourceCategories.map((category) => { const count = workspace.sources.filter((source) => sourceCategory(source) === category.id).length; const textCount = workspace.sources.filter((source) => sourceCategory(source) === category.id && source.parser_status === 'parsed').length; return <button key={category.id} className={'source-check-card ' + (selectedCategory === category.id ? 'source-check-card-active' : '')} onClick={() => { setSelectedCategory(category.id); setManuallySelectedCategory(true); }} aria-pressed={selectedCategory === category.id}><span className="source-check-mark">{count ? <Check size={16} /> : <Plus size={16} />}</span><span className="source-check-copy"><strong>{category.label}</strong><small>{category.hint}</small><em>{count ? `${count} fișiere · ${textCount} cu text extras` : 'Adaugă sau verifică sursele'}</em></span><span className="source-check-count">{count}</span></button>; })}</div>
    <details className="integrations-compact"><summary><span><strong>Integrări</strong><small>Acces și stare de sincronizare</small></span><span>SharePoint · Jira · Teams</span></summary><div className="integration-status-list">{['SharePoint', 'Jira', 'Teams'].map((name) => <div key={name}><strong>{name}</strong><span>Neconectat</span></div>)}<p>Conectorii nu sunt configurați în acest spațiu. Ultima sincronizare: indisponibilă.</p></div></details>
    {!!workspace.sources.length && <div className="source-stats"><div><span className="source-stat-green"><Check size={14} /></span><strong>{parsed}</strong><small>Text extras</small></div><div><span className="source-stat-amber"><AlertCircle size={14} /></span><strong>{failed}</strong><small>Necesită atenție</small></div>{aiAvailable && continuingSources.length > 0 && <button className="quiet-button" onClick={() => onRetry(continuingSources.map((source) => source.id))} disabled={retrying}>{retrying ? <LoaderCircle size={14} className="spin" /> : <Activity size={14} />}{retrying ? 'Continui analiza' : `Continuă analiza AI${remainingSegments ? ` · ${remainingSegments} rămase` : ''}`}</button>}{aiAvailable && !continuingSources.length && retryableSources.length > 0 && <button className="quiet-button" onClick={() => onRetry(retryableSources.map((source) => source.id))} disabled={retrying}>{retrying ? <LoaderCircle size={14} className="spin" /> : <Activity size={14} />}{retrying ? 'Reiau analiza' : 'Reia analiza AI'}</button>}<button className="primary-action" onClick={onAdd}><Plus size={15} /> Adaugă surse</button></div>}
    {!workspace.sources.length ? <div className="source-empty surface-card"><div className="welcome-icon"><Inbox size={19} /></div><h2>Începe cu sursele proiectului</h2><p>Adaugă contractul, planul, notele de ședință sau alte fișiere. Fiecare sursă își păstrează starea de citire și proveniența.</p><button className="primary-action" onClick={onAdd}><Upload size={15} /> Adaugă surse</button><small>{provider?.provider === 'none' ? 'În acest mediu sunt structurate TXT, MD, CSV, TSV, XLS și XLSX. PDF și DOCX rămân inventariate ca formate nesuportate.' : 'MD, TXT, PDF, DOCX, CSV, XLSX și XLS. Fișierele care nu pot fi citite rămân vizibile cu motivul.'}</small></div> : <>
    {(retrying || retryResult) && <div className={retrying || !/source inventory only|unavailable|failed|could not/i.test(retryResult) ? 'source-retry-message' : 'source-retry-message source-retry-error'}>{retrying ? 'Retry is running against the saved sources. Current project records remain unchanged until it finishes.' : retryResult}</div>}
    <div className="source-table surface-card"><div className="source-table-head"><div>Fișier</div><div>Starea procesării</div><div>Adăugat</div><div>Amprenta sursei</div></div>
      {filteredSources.length ? filteredSources.map((source) => {
        const expanded = openId === source.id;
        const refs = [...workspace.members, ...workspace.tasks, ...workspace.deliverables, ...workspace.risks, ...workspace.decisions].flatMap((item) => item.source_refs.filter((ref) => ref.source_id === source.id).map((ref) => ({ record: item, ref })));
        const proposedItems = workspace.proposals.filter((proposal) => proposal.status === 'proposed').flatMap((proposal) => proposal.items.filter((item) => item.review_state !== 'manager_confirmed' && item.source_refs.some((ref) => ref.source_id === source.id)).map((item) => ({ item, proposal })));
        const sourceLocation = (source as any).relative_path || source.name;
        return <div className="source-table-item" key={source.id} ref={(element) => { if (element) rowRefs.current.set(source.id, element); else rowRefs.current.delete(source.id); }}><button className={`source-row ${expanded ? 'source-row-open' : ''}`} onClick={() => { setOpenId(expanded ? '' : source.id); onClearFocus(); }} aria-expanded={expanded}><div className="source-file-cell"><span className="source-file-icon"><FileText size={17} /></span><span className="source-file-copy"><strong>{source.name}</strong><small>{sourceLocation !== source.name ? sourceLocation : source.media_type || 'File type not reported'}{source.size ? ` · ${formatBytes(source.size)}` : ''}</small></span></div><div><ParserBadge value={source.parser_status} /></div><div className="source-added-date">{displayDate(source.created_at)}</div><div className="hash-cell">{source.sha256 ? `${source.sha256.slice(0, 10)}…` : 'No fingerprint'}<ChevronDown size={15} className={expanded ? 'rotate-icon' : ''} /></div></button>
          {expanded && <div className="source-detail"><div className="source-detail-meta"><div><span>Stored name</span><strong>{source.name}</strong></div><div><span>File type</span><strong>{source.media_type || 'Not recorded'}</strong></div><div><span>SHA-256</span><strong className="full-hash">{source.sha256 || 'Not available'}</strong></div><div><span>Processing</span><strong>{titleCase(source.parser_status)}</strong></div></div><div className="source-coverage-lines"><span><strong>Parser</strong>{getSourceCoverage(source).parserText}</span><span><strong>Model review</strong>{getSourceCoverage(source).modelText}</span>{source.coverage_note && <small>{source.coverage_note}</small>}{source.extraction_note && <small>{source.extraction_note}</small>}{!source.fixture_only && source.parser_status === 'parsed' && source.extraction_coverage === 'complete' && <div className="source-reanalyze-row"><span>Looking for missed project facts?</span><button className="quiet-button" onClick={() => onRetry([source.id], { reprocess: true })} disabled={retrying}>{retrying ? <LoaderCircle size={13} className="spin" /> : <Activity size={13} />}{retrying ? 'Reanalyzing' : 'Reanalyze source'}</button><small>Creates new suggestions for review. Accepted records stay as they are.</small></div>}</div>{source.error && <div className="source-error"><AlertCircle size={15} /><span>{source.error}</span></div>}{focusRef?.source_id === source.id && <div className="source-focus-callout"><div><strong>Cited evidence</strong><span>{focusRef.location || 'Location not recorded'}</span></div>{focusRef.quote && <blockquote>“{focusRef.quote}”</blockquote>}{focusWindowLoading && <div className="quote-window-status"><LoaderCircle size={13} className="spin" /> Loading a short source window around this quote…</div>}{focusWindowError && <div className="quote-window-status quote-window-error"><AlertCircle size={13} />{focusWindowError}</div>}{focusWindow && <div className="source-quote-window"><div><strong>Context around this quote</strong><span>{focusWindow.location || focusRef.location || 'Location not recorded'}</span></div>{focusWindow.excerpt && <p><HighlightedSourceText window={focusWindow} quote={focusRef.quote} /></p>}<small>{Number(focusWindow.total_characters || 0).toLocaleString()} characters in the saved source{focusWindow.match_count > 1 ? focusWindow.ambiguous ? ` · ${focusWindow.match_count} matches; this location does not distinguish one` : ` · ${focusWindow.match_count} matches; showing the location-matched passage` : focusWindow.exact_match ? ' · exact wording found' : ' · exact wording not found in the saved text'}{focusWindow.coverage_note ? ` · ${focusWindow.coverage_note}` : ''}</small></div>}<button className="text-action" onClick={onClearFocus}>Close evidence focus</button></div>}{source.excerpt && <div className="source-excerpt"><span className="detail-label">Short text preview</span><p>{source.excerpt}</p></div>}
            <div className="source-facts"><div className="detail-label">Accepted records <span>{refs.length}</span></div>{proposedItems.length > 0 && <div className="source-proposal-links"><div><strong>{proposedItems.length} proposed item{proposedItems.length === 1 ? '' : 's'} cite this source</strong><small>They will appear in the accepted map only after review.</small></div><button className="text-action" onClick={onReview}>Review proposed changes <ArrowUpRight size={12} /></button></div>}{refs.length ? refs.slice(0, 8).map(({ record, ref }, index) => <div className="linked-fact" key={`${record.id}-${index}`}><div className="linked-fact-head"><strong>{record.title}</strong><EvidenceBadge state={record.evidence_state} /></div><span>{ref.location || 'Location not recorded'}</span>{ref.quote && <blockquote>“{ref.quote}”</blockquote>}{['member', 'task', 'deliverable'].includes(record.kind) && <button className="text-action linked-record-open" onClick={() => onOpenRecord(record.kind as 'member' | 'task' | 'deliverable', record.id)}>Open in project map <ArrowUpRight size={12} /></button>}</div>) : <p className="muted-small">No accepted records point to this source yet.</p>}</div>
          </div>}
        </div>;
      }) : <div className="source-category-empty">Nu există surse în categoria „{sourceCategories.find((item) => item.id === selectedCategory)?.label}”. Alege altă categorie sau adaugă un fișier.</div>}
    </div>
    </>}
  </div>;
}

function ParserBadge({ value }: { value?: unknown }) {
  const status = String(value || 'unknown');
  const failed = /failed|unsupported|empty|error/i.test(status);
  return <span className={`parser-badge ${failed ? 'parser-failed' : status === 'parsed' ? 'parser-parsed' : ''}`}><span />{titleCase(status)}</span>;
}

function formatBytes(bytes?: number) {
  if (!bytes) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

type SourceQuoteWindow = {
  source_id: string;
  location: string;
  excerpt: string;
  excerpt_start?: number;
  total_characters: number;
  match_start: number | null;
  match_end: number | null;
  match_count: number;
  exact_match: boolean;
  ambiguous: boolean;
  parse_coverage?: ProjectSource['parse_coverage'];
  extraction_coverage?: ProjectSource['extraction_coverage'];
  coverage_note?: string;
};

function getSourceCoverage(source: Source) {
  const fixtureOnly = source.fixture_only === true;
  const total = Number(source.segments_total || 0);
  const processed = Array.isArray(source.processed_segments) ? new Set(source.processed_segments).size : 0;
  const remaining = fixtureOnly ? 0 : total ? Math.max(0, total - processed) : source.extraction_coverage === 'partial' || source.extraction_coverage === 'pending' ? null : 0;
  const parserText = source.parser_status !== 'parsed'
    ? `Text extraction ${titleCase(source.parser_status).toLowerCase()}`
    : source.parse_coverage === 'complete'
      ? `Text extracted · ${Number(source.parsed_text_characters || 0).toLocaleString()} characters`
      : source.parse_coverage === 'partial'
        ? `Text extraction partial · ${Number(source.parsed_text_characters || 0).toLocaleString()} characters`
        : `Text extracted · coverage not recorded`;
  const modelText = fixtureOnly
    ? 'Synthetic fixture · no model run'
    : source.extraction_coverage === 'complete'
    ? `Model review complete · ${total ? `${processed} of ${total} sections` : 'all available text'}`
    : source.extraction_coverage === 'partial'
      ? `Model reviewed ${total ? `${processed} of ${total}` : processed} sections · ${remaining ?? 'more'} remain`
      : source.extraction_coverage === 'pending'
        ? `Model review pending${total ? ` · ${remaining} sections remain` : ''}`
        : source.extraction_coverage === 'unavailable'
          ? 'Model review unavailable'
          : 'Model review coverage not recorded';
  const canContinue = !fixtureOnly && (source.extraction_coverage === 'pending' || source.extraction_coverage === 'partial');
  const canRetry = !fixtureOnly && source.parser_status === 'parsed' && ['unavailable', 'legacy_unknown', undefined].includes(source.extraction_coverage);
  return { total, processed, remaining, parserText, modelText, canContinue, canRetry };
}

function extractionBatchMessage(extraction: any, sources: Source[]) {
  if (extraction?.provider_mode === 'degraded') {
    const parserFailures = sources.filter((source) => ['failed', 'unsupported', 'empty'].includes(String(source.parser_status)));
    if (parserFailures.length) {
      const details = parserFailures.map((source) => `${source.name}${source.error ? ` (${source.error})` : ` (${titleCase(source.parser_status).toLowerCase()})`}`).join(', ');
      return `Source inventory only. The source was saved, but the parser could not read ${details}. Open Sources to review its status, then add a readable version and retry.`;
    }
    return `Source inventory only. ${extraction.error || 'The configured provider could not review the saved text.'}`;
  }
  const coverage = extraction?.coverage || {};
  const remaining = Number(coverage.segments_remaining ?? sources.reduce((count, source) => count + (getSourceCoverage(source).remaining || 0), 0));
  const sent = Number(coverage.segments_sent || 0);
  if (remaining > 0) return `This run reviewed ${sent} text sections. ${remaining} remain. Continue model review from Sources, and review the proposed changes separately.`;
  if (coverage.model_complete === true && coverage.parser_complete === false) return `Model review covered all ${Number(coverage.total_segments || sent).toLocaleString()} parsed text sections. Parser coverage is limited in ${Number(coverage.parser_limited_sources || 0)} source${Number(coverage.parser_limited_sources || 0) === 1 ? '' : 's'}; check their source notes.`;
  if (coverage.complete === true) return `Model review is complete for ${Number(coverage.total_segments || sent).toLocaleString()} queued text sections, with full parser coverage.`;
  return 'This run finished. Review file processing, model coverage, and any proposed changes.';
}

function HighlightedSourceText({ window, quote }: { window: SourceQuoteWindow; quote: string }) {
  const text = window.excerpt || '';
  if (!window.exact_match || !text) return <>{text}</>;
  const fromAbsolute = window.match_start !== null && window.excerpt_start !== undefined ? window.match_start - window.excerpt_start : -1;
  const start = fromAbsolute >= 0 && text.slice(fromAbsolute, fromAbsolute + quote.length) === quote ? fromAbsolute : text.indexOf(quote);
  const end = window.match_end ?? (start >= 0 ? start + quote.length : -1);
  if (start < 0 || end <= start || end > text.length) return <>{text}</>;
  return <>{text.slice(0, start)}<mark>{text.slice(start, end)}</mark>{text.slice(end)}</>;
}

function UpdatesPage({ workspace, text, setText, sourceName, setSourceName, onSubmit, onContinueModelReview, coverageMessage, continuationPending, retrying, busy, jobPhase, proposals, onDecide, onReviewItem, onOpenSource, proposalBusyId, sent }: {
  workspace: Workspace; text: string; setText: (value: string) => void; sourceName: string; setSourceName: (value: string) => void;
  onSubmit: (event: React.FormEvent) => void; onContinueModelReview: () => void; coverageMessage: string; continuationPending: boolean; retrying: boolean; busy: boolean; jobPhase: string; proposals: ProjectProposal[];
  onDecide: (proposal: ProjectProposal, decision: 'apply' | 'reject', itemIds?: string[]) => void; onReviewItem: (proposal: ProjectProposal, itemId: string, action: 'reject' | 'correct', reason: string, fields?: Record<string, unknown>) => void; onOpenSource: (ref: SourceRef) => void; proposalBusyId: string; sent: boolean;
}) {
  const [rejectReason, setRejectReason] = useState('');
  const pendingDecisions = workspace.proposals.filter((proposal) => proposal.status === 'proposed').flatMap((proposal) => proposal.items.filter((item) => item.record_kind === 'decision').map((item) => ({ proposal, item })));
  return <div className="updates-layout">
    {pendingDecisions.map(({ proposal, item }) => <section className="decision-recommendation surface-card" key={`${proposal.id}-${item.id}`}><div className="recommendation-mark"><Sparkles size={17} /></div><div className="recommendation-copy"><div className="eyebrow">RECOMANDARE CODEX · PROPUNERE ÎN AȘTEPTAREA PM-ULUI</div><h2>{item.title}</h2><p>{item.fields.description || 'Deschide citatele pentru context și decide dacă recomanzi acest pas.'}</p><EvidenceList refs={item.source_refs || []} sources={workspace.sources} compact onOpenSource={onOpenSource} /><small>Nu este aprobată și nu a fost trimis niciun mesaj.</small><button type="button" className="text-action" onClick={() => document.getElementById('proposal-review')?.scrollIntoView({ behavior: 'smooth', block: 'start' })}>Verifică propunerea în detaliu <ArrowDownRight size={12} /></button></div></section>)}
    {workspace.decisions.map((decision) => {
      const question = decision.description?.match(/[„“](.+?)[””]/)?.[1] || decision.title;
      return <section className="decision-recommendation surface-card" key={decision.id}><div className="recommendation-mark"><Sparkles size={17} /></div><div className="recommendation-copy"><div className="eyebrow">ÎNTREBARE RECOMANDATĂ · PROPUNERE, NU MESAJ TRIMIS</div><h2>{decision.title}</h2><p>{decision.description || question}</p><EvidenceList refs={decision.source_refs || []} sources={workspace.sources} compact onOpenSource={onOpenSource} /><small>Verifică textul și sursele înainte să o adaugi în ciornă. Nimic nu se trimite automat.</small></div><button type="button" className="primary-action" onClick={() => setText(question)}><Plus size={14} /> Pune în ciornă</button></section>;
    })}
    <section className="update-compose surface-card"><div className="compose-heading"><span className="compose-icon"><Activity size={17} /></span><div><h2>Adaugă un check-in sau o notă de ședință</h2><p>TeamCreator pregătește schimbări pentru revizuire. Proiectul nu se modifică până la aprobarea ta.</p></div></div>
      <form onSubmit={onSubmit}><label className="field-label">Eticheta sursei <span className="optional-label">opțional</span><input value={sourceName} onChange={(event) => setSourceName(event.target.value)} placeholder="ex. Check-in de vineri, 26 septembrie" /></label><label className="field-label">Textul actualizării<textarea value={text} onChange={(event) => setText(event.target.value)} rows={6} placeholder="Lipește actualizarea sau nota de ședință. Numele și datele care nu apar în sursă rămân necunoscute." required /></label><div className="compose-footer"><span className="compose-note"><ShieldCheck size={14} /> Revizuire în aplicație. Nu se trimite niciun mesaj echipei.</span><button className="primary-action" type="submit" disabled={busy || !text.trim()}>{busy ? <LoaderCircle size={15} className="spin" /> : <Send size={15} />}{busy ? jobPhase || 'Pregătesc propunerea' : 'Pregătește schimbări'}</button></div></form>
      {sent && <div className="success-inline"><Check size={15} /> Actualizarea a fost primită. Revizuiește propunerile înainte să schimbe proiectul.</div>}
      {sent && coverageMessage && <div className="checkin-coverage-feedback"><span>{coverageMessage}</span>{continuationPending && <button className="quiet-button" onClick={onContinueModelReview} disabled={retrying}>{retrying ? <LoaderCircle size={14} className="spin" /> : <Activity size={14} />}{retrying ? 'Continui analiza' : 'Continuă analiza AI'}</button>}{proposals.length > 0 && <button className="text-action" onClick={() => document.getElementById('proposal-review')?.scrollIntoView({ behavior: 'smooth', block: 'start' })}>Revizuiește propunerile <ArrowDownRight size={12} /></button>}</div>}
    </section>
    <section className="proposals-section" id="proposal-review"><div className="proposal-head"><div><div className="eyebrow">REVIZUIRE DE CĂTRE PM</div><h2>Schimbări propuse</h2><p>Fiecare propunere rămâne separată. Aplicarea ei se înregistrează în istoricul proiectului.</p></div><span className="proposal-count">{proposals.length} în așteptare</span></div>
      {proposals.length ? <div className="proposal-list">{proposals.map((proposal) => <ProposalCard key={proposal.id} proposal={proposal} onDecide={onDecide} onReviewItem={onReviewItem} onOpenSource={onOpenSource} busy={proposalBusyId === proposal.id || proposalBusyId.startsWith(`${proposal.id}:`)} rejectReason={rejectReason} setRejectReason={setRejectReason} workspace={workspace} />)}</div> : <div className="proposal-empty surface-card"><span className="empty-check"><CheckCheck size={16} /></span><strong>Nu sunt schimbări propuse în așteptare</strong><p>Importurile și notele noi vor apărea aici pentru revizuire.</p></div>}
    </section>
  </div>;
}

function ProposalCard({ proposal, onDecide, onReviewItem, onOpenSource, busy, rejectReason, setRejectReason, workspace }: { proposal: ProjectProposal; onDecide: (proposal: ProjectProposal, decision: 'apply' | 'reject', itemIds?: string[]) => void; onReviewItem: (proposal: ProjectProposal, itemId: string, action: 'reject' | 'correct', reason: string, fields?: Record<string, unknown>) => void; onOpenSource: (ref: SourceRef) => void; busy: boolean; rejectReason: string; setRejectReason: (value: string) => void; workspace: Workspace }) {
  const appliedCount = proposal.items.filter((item) => item.review_state === 'manager_confirmed').length;
  const remainingItems = proposal.items.filter((item) => item.review_state !== 'manager_confirmed');
  const eligibleItems = remainingItems.filter((item) => !item.conflict && !item.stale && item.review_state !== 'unresolved' && !hasBaselineOnlyApprovalStatus(item));
  const heldItems = remainingItems.filter((item) => !eligibleItems.some((eligible) => eligible.id === item.id));
  const eligibleIds = eligibleItems.map((item) => item.id);
  const eligibleKey = eligibleIds.join('|');
  const allIdsKey = proposal.items.map((item) => item.id).join('|');
  const knownIdsRef = useRef(allIdsKey);
  const [selectedItemIds, setSelectedItemIds] = useState<string[]>(eligibleIds);
  useEffect(() => {
    const knownIds = new Set(knownIdsRef.current.split('|').filter(Boolean));
    const eligibleSet = new Set(eligibleIds);
    setSelectedItemIds((current) => {
      const next = new Set(current.filter((id) => eligibleSet.has(id)));
      for (const id of eligibleIds) if (!knownIds.has(id)) next.add(id);
      return [...next];
    });
    knownIdsRef.current = allIdsKey;
  }, [proposal.id, eligibleKey, allIdsKey]);
  const selectedSet = new Set(selectedItemIds);
  const selectedCount = eligibleIds.filter((id) => selectedSet.has(id)).length;
  const toggleItem = (itemId: string) => setSelectedItemIds((current) => current.includes(itemId) ? current.filter((id) => id !== itemId) : [...current, itemId]);
  const partiallyApplied = appliedCount > 0 && proposal.status === 'proposed';
  const statusLabel = partiallyApplied ? `Aplicată parțial · ${appliedCount} acceptate · ${remainingItems.length} rămase` : heldItems.length ? `Propusă · ${eligibleItems.length} gata · ${heldItems.length} de verificat` : `Propusă · ${eligibleItems.length} gata de revizuire`;
  const proposalTitle = /^review updates from /i.test(proposal.title) ? `Actualizări propuse din ${proposal.source_ids.length} surse` : proposal.title;
  const proposalSummary = /source-grounded changes? across/i.test(proposal.summary) ? `${proposal.items.length} schimbări susținute de surse. Verifică citatele înainte de aprobare.` : proposal.summary;
  return <article className="proposal-card surface-card"><div className="proposal-card-top"><span className="proposal-icon"><Activity size={15} /></span><div className="proposal-title"><div className="proposal-statusline"><span className="proposal-status-dot" /> {statusLabel} <span>·</span>{displayDate(proposal.created_at)}</div><h3>{proposalTitle}</h3><p>{proposalSummary}</p></div><span className="proposal-mode">{proposal.provider_mode === 'model' ? 'Codex CLI · AI' : 'Inventar de surse'}</span></div>
    {!!proposal.items.length && <div className="proposal-changes">{proposal.items.map((item) => {
      const applied = item.review_state === 'manager_confirmed';
      const baselineStatusGuard = hasBaselineOnlyApprovalStatus(item);
      const held = !applied && (item.conflict || item.stale || item.review_state === 'unresolved' || baselineStatusGuard);
      const heldLabel = baselineStatusGuard ? 'Reținută · doar data de referință' : item.stale ? 'Reținută · proiect modificat' : 'Reținută pentru verificare';
      return <div className="proposal-change" key={item.id}><div className="proposal-item-review"><label className={`proposal-item-select ${applied ? 'item-select-applied' : held ? 'item-select-held' : ''}`}><input type="checkbox" checked={applied || selectedSet.has(item.id)} onChange={() => { if (!applied && !held) toggleItem(item.id); }} disabled={busy || applied || held} /><span>{applied ? 'Aplicată' : held ? heldLabel : selectedSet.has(item.id) ? 'Selectată pentru aprobare' : 'Păstrează în așteptare'}</span></label></div><div className="proposal-change-label"><span className={`operation-badge ${item.operation}`}>{titleCase(item.operation)}</span><strong>{item.title || item.fields.title || 'Înregistrare de proiect'}</strong><span className="change-kind">{titleCase(item.record_kind)}</span>{item.consequential && <span className="consequential-tag"><ShieldCheck size={12} /> Cu impact</span>}</div>
        {proposalFieldDiffs(item, proposal, workspace).map(({ field, before, value, hasBefore }) => <div className="field-diff" key={field}><span>{proposalFieldLabel(field)}</span><div>{hasBefore && <del>{proposalFieldValue(field, before, proposal, workspace)}</del>}<ArrowRight size={13} /><strong>{proposalFieldValue(field, value, proposal, workspace)}</strong></div></div>)}
        {proposalDependencyWarnings(item, proposal, workspace).map((dependency, index) => <div className="dependency-review-needed" key={`${item.id}-dependency-${index}`}><div><AlertTriangle size={13} /><strong>Necesită legare</strong><span>{dependency.label}</span></div><EvidenceList refs={dependency.sourceRefs} sources={workspace.sources} compact onOpenSource={onOpenSource} /></div>)}
        {item.conflict && <div className="conflict-inline"><AlertTriangle size={13} /> Propunerea conține afirmații diferite. Verifică ambele surse înainte de decizie.</div>}
        {!item.conflict && baselineStatusGuard && <div className="conflict-inline"><AlertTriangle size={13} /> Sursa aprobă o dată de referință, nu starea livrării. Păstrează schimbarea în așteptare.</div>}
        {item.source_refs.length > 0 && <EvidenceList refs={item.source_refs} sources={workspace.sources} compact onOpenSource={onOpenSource} />}
        <ProposalItemActions proposal={proposal} item={item} applied={applied} held={held} busy={busy} onDecide={onDecide} onReviewItem={onReviewItem} />
      </div>;
    })}</div>}
    {proposal.conflicts.length > 0 && <div className="proposal-conflicts"><div className="detail-label"><AlertTriangle size={14} /> Afirmații diferite între surse</div>{proposal.conflicts.map((conflict, index) => <div className="conflict-row" key={`${conflict.field}-${index}`}><strong>{conflict.record_title} · {titleCase(conflict.field)}</strong>{conflict.claims.map((claim, claimIndex) => <div className="conflict-claim" key={claimIndex}><span>„{claim.value || 'Necunoscut'}”</span><EvidenceList refs={claim.source_refs} sources={workspace.sources} compact onOpenSource={onOpenSource} /></div>)}</div>)}</div>}
    {proposal.missing_info.length > 0 && <div className="missing-info"><CircleHelp size={14} /><span><strong>Note de analiză:</strong> {proposal.missing_info.map((note) => safeHistoryText(note)).join(' · ')}</span></div>}
    <div className="proposal-card-footer"><div className="decision-note">{selectedCount} selectate · {appliedCount} aprobate · {heldItems.length} reținute</div><div className="proposal-actions"><button className="quiet-button reject-button" onClick={() => onDecide(proposal, 'reject')} disabled={busy}><X size={14} /> {partiallyApplied ? 'Respinge restul' : 'Respinge propunerea'}</button><button className="primary-action" onClick={() => onDecide(proposal, 'apply', eligibleIds.filter((id) => selectedSet.has(id)))} disabled={busy || selectedCount === 0}>{busy ? <LoaderCircle size={14} className="spin" /> : <Check size={14} />}{selectedCount ? ` Aprobă ${selectedCount} ${selectedCount === 1 ? 'schimbare' : 'schimbări'}` : eligibleItems.length ? 'Selectează schimbările' : 'Nicio schimbare de aprobat'}</button></div></div>
  </article>;
}

type CorrectionDraft = Record<'title' | 'owner' | 'status' | 'due' | 'baseline_due' | 'current_forecast' | 'description' | 'role' | 'member_type', string>;

function proposalCorrectionDraft(item: ProjectProposal['items'][number]): CorrectionDraft {
  const fields = item.fields as Record<string, unknown>;
  return {
    title: String(fields.title || item.title || ''),
    owner: String(fields.owner || ''),
    status: String(fields.status || ''),
    due: String(fields.due || ''),
    baseline_due: String(fields.baseline_due || ''),
    current_forecast: String(fields.current_forecast || ''),
    description: String(fields.description || ''),
    role: String(fields.role || ''),
    member_type: String(fields.member_type || 'unknown'),
  };
}

function ProposalItemActions({ proposal, item, applied, held, busy, onDecide, onReviewItem }: {
  proposal: ProjectProposal; item: ProjectProposal['items'][number]; applied: boolean; held: boolean; busy: boolean;
  onDecide: (proposal: ProjectProposal, decision: 'apply' | 'reject', itemIds?: string[]) => void;
  onReviewItem: (proposal: ProjectProposal, itemId: string, action: 'reject' | 'correct', reason: string, fields?: Record<string, unknown>) => void;
}) {
  const [mode, setMode] = useState<'reject' | 'correct' | null>(null);
  const [reason, setReason] = useState('');
  const original = proposalCorrectionDraft(item);
  const [draft, setDraft] = useState<CorrectionDraft>(original);
  const update = (key: keyof CorrectionDraft, value: string) => setDraft((current) => ({ ...current, [key]: value }));
  const submitReject = (event: React.FormEvent) => {
    event.preventDefault();
    if (!reason.trim()) return;
    setMode(null);
    onReviewItem(proposal, item.id, 'reject', reason);
  };
  const submitCorrection = (event: React.FormEvent) => {
    event.preventDefault();
    if (!reason.trim()) return;
    const changed: Record<string, unknown> = {};
    for (const key of Object.keys(original) as Array<keyof CorrectionDraft>) {
      if (draft[key] === original[key]) continue;
      const nullable = ['owner', 'status', 'due', 'baseline_due', 'current_forecast', 'description', 'role'].includes(key);
      changed[key] = nullable && !draft[key].trim() ? null : draft[key].trim();
    }
    if (!Object.keys(changed).length) return;
    setMode(null);
    onReviewItem(proposal, item.id, 'correct', reason, changed);
  };
  return <div className="proposal-item-actions">
    {!applied && <div className="proposal-item-action-buttons">
      <button className="item-accept-action" onClick={() => onDecide(proposal, 'apply', [item.id])} disabled={busy || held}><Check size={13} /> Acceptă informația</button>
      <button className="item-correct-action" onClick={() => { setReason(''); setMode(mode === 'correct' ? null : 'correct'); }} disabled={busy}>Corectează</button>
      <button className="item-reject-action" onClick={() => { setReason(''); setMode(mode === 'reject' ? null : 'reject'); }} disabled={busy}>Respinge informația</button>
    </div>}
    {mode === 'reject' && <form className="proposal-item-action-form" onSubmit={submitReject}><label className="field-label">Motivul respingerii<input autoFocus value={reason} onChange={(event) => setReason(event.target.value)} placeholder="ex. Citatul nu susține această valoare" required /></label><div><button type="button" className="quiet-button" onClick={() => setMode(null)}>Renunță</button><button type="submit" className="item-reject-action" disabled={busy || !reason.trim()}>{busy ? <LoaderCircle size={13} className="spin" /> : <X size={13} />} Respinge acest fapt</button></div></form>}
    {mode === 'correct' && <form className="proposal-item-action-form correction-form" onSubmit={submitCorrection}><div className="correction-field-grid">
      <label className="field-label">Informație<input autoFocus value={draft.title} onChange={(event) => update('title', event.target.value)} required /></label>
      {item.record_kind === 'member' ? <><label className="field-label">Rol<input value={draft.role} onChange={(event) => update('role', event.target.value)} /></label><label className="field-label">Tip membru<select value={draft.member_type} onChange={(event) => update('member_type', event.target.value)}>{['person', 'group', 'organization', 'role', 'unknown'].map((value) => <option value={value} key={value}>{titleCase(value)}</option>)}</select></label></> : <>
        <label className="field-label">Responsabil<input value={draft.owner} onChange={(event) => update('owner', event.target.value)} /></label>
        <label className="field-label">Stare<input value={draft.status} onChange={(event) => update('status', event.target.value)} /></label>
        <label className="field-label">Termen curent<input value={draft.due} onChange={(event) => update('due', event.target.value)} placeholder="YYYY-MM-DD sau textul din sursă" /></label>
        <label className="field-label">Descriere<textarea rows={2} value={draft.description} onChange={(event) => update('description', event.target.value)} /></label>
      </>}
      </div><label className="field-label">Motivul corectării<input value={reason} onChange={(event) => setReason(event.target.value)} placeholder="ex. Confirmat cu responsabilul proiectului" required /></label><div><button type="button" className="quiet-button" onClick={() => setMode(null)}>Renunță</button><button type="submit" className="item-correct-action" disabled={busy || !reason.trim() || Object.keys(original).every((key) => draft[key as keyof CorrectionDraft] === original[key as keyof CorrectionDraft])}>{busy ? <LoaderCircle size={13} className="spin" /> : <Check size={13} />} Salvează corectarea</button></div></form>}
  </div>;
}

function hasBaselineOnlyApprovalStatus(item: ProjectProposal['items'][number]) {
  const status = String(item.fields.status || '').trim().toLowerCase();
  if (status !== 'approved') return false;
  return item.source_refs.length > 0 && item.source_refs.every(approvalIsOnlyForBaseline);
}

const proposalDisplayFields = ['member_type', 'role', 'owner', 'owner_id', 'status', 'due', 'baseline_due', 'current_forecast', 'depends_on', 'description'] as const;

function proposalFieldDiffs(item: ProjectProposal['items'][number], proposal: ProjectProposal, workspace: Workspace) {
  const fields = item.fields as Record<string, unknown>;
  const before = (item.before || {}) as Record<string, unknown>;
  const hasOwnerName = typeof fields.owner === 'string' && Boolean(fields.owner.trim());
  return proposalDisplayFields
    .filter((field) => field in fields && !(item.record_kind === 'member' && ['owner', 'owner_id', 'status', 'due', 'baseline_due', 'current_forecast', 'depends_on'].includes(field)))
    .filter((field) => !(field === 'status' && hasBaselineOnlyApprovalStatus(item)))
    .filter((field) => !(field === 'owner_id' && hasOwnerName))
    .filter((field) => {
      const value = fields[field];
      if (value === null || value === undefined || value === '') return false;
      if (Array.isArray(value) && value.length === 0) return false;
      if (item.before && JSON.stringify(before[field] ?? null) === JSON.stringify(value)) return false;
      return Boolean(proposalFieldValue(field, value, proposal, workspace));
    })
    .map((field) => ({ field, value: fields[field], before: before[field], hasBefore: Boolean(item.before && field in before) }));
}

function proposalFieldLabel(field: string) {
  return ({ member_type: 'Member type', owner: 'Owner', owner_id: 'Owner', due: 'Current due date', baseline_due: 'Accepted baseline', current_forecast: 'Current forecast', depends_on: 'Dependencies' } as Record<string, string>)[field] || titleCase(field);
}

function proposalFieldValue(field: string, value: unknown, proposal: ProjectProposal, workspace: Workspace): string {
  if (field === 'member_type' || field === 'status') return titleCase(value);
  if (['due', 'baseline_due', 'current_forecast'].includes(field)) return displayDate(value);
  if (field === 'owner' || field === 'owner_id') return resolveProposalOwner(value, proposal, workspace);
  if (field === 'depends_on') {
    const ids = Array.isArray(value) ? value : [value];
    const titles = ids.map((id) => resolveProposalRecordLabel(id, proposal, workspace)).filter(Boolean);
    return titles.length ? titles.join(', ') : `${ids.length} linked ${ids.length === 1 ? 'item' : 'items'}`;
  }
  return typeof value === 'string' ? (field === 'description' ? truncate(value.trim(), 220) : value.trim()) : '';
}

function resolveProposalOwner(value: unknown, proposal: ProjectProposal, workspace: Workspace) {
  const raw = String(value ?? '').trim();
  if (!raw) return 'Unspecified owner or team';
  const existing = workspace.members.find((member) => member.id === raw);
  if (existing?.title) return existing.title;
  const normalized = normalizeCandidateName(raw);
  const proposed = proposal.items.find((item) => item.record_kind === 'member' && normalizeCandidateName(item.fields.title || item.title) === normalized);
  if (proposed?.fields.title || proposed?.title) return String(proposed.fields.title || proposed.title);
  if (raw.startsWith('candidate:member:')) return titleCase(raw.slice('candidate:member:'.length).replace(/[-_]+/g, ' '));
  return raw.startsWith('candidate:') ? 'Proposed owner or team' : raw;
}

function normalizeCandidateName(value: unknown) {
  return String(value || '').toLowerCase().replace(/^candidate:(?:member|task|deliverable):/, '').replace(/[^a-z0-9]+/g, ' ').trim();
}

function unresolvedDependencyLabel(label: string, workspace: Workspace) {
  const normalized = normalizeCandidateName(label);
  const existing = [...workspace.tasks, ...workspace.deliverables].find((record) => record.id === label || normalizeCandidateName(record.title) === normalized || normalizeCandidateName((record as any).external_code || (record as any).code) === normalized);
  if (existing) {
    const code = String((existing as any).external_code || (existing as any).code || '');
    return code && !existing.title.toLowerCase().includes(code.toLowerCase()) ? `${existing.title} · ${code}` : existing.title;
  }
  for (const proposal of workspace.proposals.filter((item) => item.status === 'proposed')) {
    const proposed = resolveProposalRecordItem(label, proposal);
    if (proposed) return proposalRecordLabel(proposed);
  }
  return safeHistoryText(label);
}

function dependencyEvidence(record: WorkspaceRecord, label: string) {
  const refsMap = (record as any).dependency_refs;
  const matching: SourceRef[] = [];
  if (refsMap && typeof refsMap === 'object') {
    const normalized = normalizeCandidateName(label);
    for (const [key, refs] of Object.entries(refsMap as Record<string, SourceRef[]>)) {
      if (normalizeCandidateName(key) === normalized || (Array.isArray(refs) && refs.some((ref) => ref.quote?.toLowerCase().includes(label.toLowerCase())))) {
        matching.push(...(Array.isArray(refs) ? refs : []));
      }
    }
  }
  const byQuote = (record.source_refs || []).filter((ref) => ref.quote?.toLowerCase().includes(label.toLowerCase()));
  const refs = matching.length ? matching : byQuote;
  return [...new Map(refs.map((ref) => [`${ref.source_id}|${ref.location}|${ref.quote}`, ref])).values()];
}

function proposalRecordCode(item: ProjectProposal['items'][number]) {
  const fields = item.fields as Record<string, unknown>;
  const explicit = fields.external_code || fields.code;
  if (typeof explicit === 'string' && explicit.trim()) return explicit.trim();
  for (const ref of item.source_refs) {
    const match = ref.quote?.match(/\b[A-Z]{1,4}-\d+\b/);
    if (match) return match[0];
  }
  return '';
}

function proposalRecordLabel(item: ProjectProposal['items'][number]) {
  const title = String(item.fields.title || item.title || 'Project item');
  const code = proposalRecordCode(item);
  return code && !title.toLowerCase().includes(code.toLowerCase()) ? `${title} · ${code}` : title;
}

function resolveProposalRecordItem(value: unknown, proposal: ProjectProposal) {
  const id = String(value ?? '');
  const normalized = normalizeCandidateName(id);
  return proposal.items.find((item) => {
    if (item.record_kind !== 'task' && item.record_kind !== 'deliverable') return false;
    if (item.id === id || item.record_id === id || item.fields.id === id) return true;
    const title = normalizeCandidateName(item.fields.title || item.title);
    const code = normalizeCandidateName(proposalRecordCode(item));
    return Boolean(normalized && (normalized === title || normalized === code || (code && normalized.includes(code)) || (title && normalized.includes(title))));
  }) || null;
}

function resolveProposalRecordLabel(value: unknown, proposal: ProjectProposal, workspace: Workspace) {
  const id = String(value ?? '');
  const existing = [...workspace.tasks, ...workspace.deliverables].find((record) => record.id === id);
  if (existing?.title) {
    const code = String((existing as any).external_code || (existing as any).code || '');
    return code && !existing.title.toLowerCase().includes(code.toLowerCase()) ? `${existing.title} · ${code}` : existing.title;
  }
  const proposed = resolveProposalRecordItem(value, proposal);
  return proposed ? proposalRecordLabel(proposed) : '';
}

function proposalDependencyWarnings(item: ProjectProposal['items'][number], proposal: ProjectProposal, workspace: Workspace) {
  const fields = item.fields as Record<string, unknown>;
  const unresolved = Array.isArray(fields.unresolved_dependencies) ? fields.unresolved_dependencies.map(String) : [];
  const links = Array.isArray(fields.depends_on) ? fields.depends_on.map(String) : [];
  const dependencyRefs = fields.dependency_refs && typeof fields.dependency_refs === 'object' ? fields.dependency_refs as Record<string, SourceRef[]> : {};
  return unresolved.filter((raw) => {
    const target = resolveProposalRecordItem(raw, proposal);
    return !links.some((link) => {
      if (normalizeCandidateName(link) === normalizeCandidateName(raw)) return true;
      const linked = resolveProposalRecordItem(link, proposal);
      return Boolean(target && linked?.id === target.id);
    });
  }).map((raw) => {
    const target = resolveProposalRecordItem(raw, proposal);
    const label = target ? proposalRecordLabel(target) : safeHistoryText(raw);
    const rawKey = normalizeCandidateName(raw);
    const refsFromMap = Object.entries(dependencyRefs).filter(([key]) => {
      const keyTarget = resolveProposalRecordItem(key, proposal);
      return (target && keyTarget?.id === target.id) || normalizeCandidateName(key) === rawKey;
    }).flatMap(([, refs]) => refs || []);
    const refsFromQuotes = item.source_refs.filter((ref) => ref.quote?.toLowerCase().includes(raw.toLowerCase()) || (target && ref.quote?.toLowerCase().includes(String(target.fields.title || target.title).toLowerCase())));
    return { label, sourceRefs: refsFromMap.length ? refsFromMap : refsFromQuotes.length ? refsFromQuotes : item.source_refs };
  });
}

function valueText(value: unknown): string {
  if (value === null || value === undefined || value === '') return 'Unknown';
  if (Array.isArray(value)) return value.join(', ') || 'None';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function ManualRecordModal({ workspace, initialKind = 'task', busy, onClose, onSave }: { workspace: Workspace | null; initialKind?: 'member' | 'task'; busy: boolean; onClose: () => void; onSave: (kind: 'member' | 'task' | 'deliverable', fields: Record<string, unknown>) => void }) {
  const [kind, setKind] = useState<'member' | 'task' | 'deliverable'>(initialKind);
  const [memberType, setMemberType] = useState<MemberType>('unknown');
  const [title, setTitle] = useState('');
  const [role, setRole] = useState('');
  const [owner, setOwner] = useState('');
  const [due, setDue] = useState('');
  const [status, setStatus] = useState('');
  const [reason, setReason] = useState('');
  const [dependencies, setDependencies] = useState<string[]>([]);
  if (!workspace) return null;
  const toggle = (id: string) => setDependencies((current) => current.includes(id) ? current.filter((value) => value !== id) : [...current, id]);
  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    onSave(kind, { title: title.trim(), role: role.trim() || undefined, member_type: kind === 'member' ? memberType : undefined, owner: kind === 'member' ? null : owner || null, due: kind === 'member' ? null : due || null, status: kind === 'member' ? null : status || null, depends_on: kind === 'member' ? [] : dependencies, reason: reason.trim() || undefined });
  };
  return <Modal title="Adaugă în proiect" onClose={onClose}><form className="manual-record-form" onSubmit={submit}>
    <p className="modal-copy">Adaugă un membru, o sarcină sau un livrabil. Modificarea va fi păstrată în istoricul proiectului.</p>
    <label className="field-label">Tip<select value={kind} onChange={(event) => setKind(event.target.value as typeof kind)}><option value="task">Sarcină</option><option value="deliverable">Livrabil</option><option value="member">Membru sau echipă</option></select></label>
    <label className="field-label">{kind === 'member' ? 'Numele membrului sau echipei' : kind === 'task' ? 'Numele sarcinii' : 'Numele livrabilului'}<input autoFocus value={title} onChange={(event) => setTitle(event.target.value)} placeholder={kind === 'task' ? 'ex. Verifică planul cu beneficiarul' : kind === 'deliverable' ? 'ex. Proiect tehnic aprobat' : 'ex. Echipa de verificare'} required /></label>
    {kind === 'member' ? <><label className="field-label">Tip de membru<select value={memberType} onChange={(event) => setMemberType(event.target.value as MemberType)}><option value="unknown">Nespecificat</option><option value="person">Persoană</option><option value="group">Grup</option><option value="organization">Organizație</option><option value="role">Rol</option></select></label><label className="field-label">Rol <span className="optional-label">opțional</span><input value={role} onChange={(event) => setRole(event.target.value)} placeholder="ex. Verificator tehnic" /></label></> : <>
    <label className="field-label">Responsabil<select value={owner} onChange={(event) => setOwner(event.target.value)}><option value="">Necunoscut</option>{graphMembers(workspace).map((person) => <option value={person.title || ''} key={person.id}>{person.title} · {titleCase(person.member_type || 'unspecified')}</option>)}</select></label>
      <div className="manual-row"><label className="field-label">Termen curent<input type="date" value={due} onChange={(event) => setDue(event.target.value)} /></label><label className="field-label">Stare curentă<select value={status} onChange={(event) => setStatus(event.target.value)}><option value="">Necunoscut</option>{['not_started', 'in_progress', 'blocked', 'complete', 'accepted'].map((value) => <option value={value} key={value}>{titleCase(value)}</option>)}</select></label></div>
      {kind === 'task' && workspace.tasks.length > 0 && <div><div className="field-label">Depinde de <small className="field-help">Selectează sarcinile care trebuie finalizate înainte.</small></div><div className="dependency-options manual-dependencies">{workspace.tasks.map((task) => <label key={task.id}><input type="checkbox" checked={dependencies.includes(task.id)} onChange={() => toggle(task.id)} /><span>{task.title}</span></label>)}</div></div>}
    </>}
    <label className="field-label">Motivul adăugării <span className="optional-label">opțional, păstrat în istoric</span><input value={reason} onChange={(event) => setReason(event.target.value)} placeholder="ex. Confirmat la ședința proiectului" /></label>
    <div className="manual-source-note"><CircleHelp size={14} /><span>Adăugat de manager. Poți adăuga ulterior sursa justificativă.</span></div>
    <div className="modal-footer"><button type="button" className="quiet-button" onClick={onClose}>Renunță</button><button type="submit" className="primary-action" disabled={busy || !title.trim()}>{busy ? <LoaderCircle size={14} className="spin" /> : <Plus size={14} />} Adaugă în proiect</button></div>
  </form></Modal>;
}

function HistoryPage({ workspace }: { workspace: Workspace }) {
  const [expanded, setExpanded] = useState<string[]>([]);
  const entries = workspace.audit.map((item) => ({ ...item, sourceIds: item.source_ids || [] })).sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
  return <div className="history-layout"><div className="history-intro surface-card"><span className="history-shield"><History size={17} /></span><div><h2>Istoricul proiectului</h2><p>Editările și deciziile managerului sunt păstrate împreună cu afirmațiile inițiale.</p></div><span className="history-count">{entries.length} evenimente</span></div>
    {entries.length ? <div className="history-list">{entries.map((entry) => {
      const hasSnapshots = entry.before !== undefined || entry.after !== undefined;
      const isExpanded = expanded.includes(entry.id);
      return <article className="history-entry" key={entry.id}><div className="history-rail"><span className={`history-event-dot ${/reject/i.test(entry.type) ? 'event-rejected' : /apply|edit/i.test(entry.type) ? 'event-approved' : ''}`} /><span className="history-line" /></div><div className="history-entry-card surface-card"><div className="history-entry-top"><span className="history-event-type">{historyTypeLabel(entry.type)}</span><time>{displayDate(entry.at)}</time></div><div className="history-entry-summary"><h3>{safeHistoryText(entry.summary)}</h3>{hasSnapshots && <button className="history-detail-toggle" onClick={() => setExpanded((current) => isExpanded ? current.filter((id) => id !== entry.id) : [...current, entry.id])}>{isExpanded ? 'Ascunde modificările' : 'Vezi modificările'}<ChevronDown size={13} className={isExpanded ? 'rotate-icon' : ''} /></button>}</div><div className="history-entry-meta"><span>{entry.actor === 'browser-local manager' || entry.actor === 'manager' ? 'Manager' : entry.actor || 'Eveniment de proiect'}</span>{entry.sourceIds.length > 0 && <span><FileText size={12} />{entry.sourceIds.length} · {entry.sourceIds.length === 1 ? 'sursă' : 'surse'}</span>}</div>{hasSnapshots && isExpanded && <SnapshotDiff before={entry.before} after={entry.after} workspace={workspace} />}</div></article>;
    })}</div> : <div className="history-empty surface-card"><History size={20} /><h2>Nu există încă evenimente</h2><p>Sursele, editările și deciziile de revizuire vor apărea aici.</p></div>}
  </div>;
}

function SnapshotDiff({ before, after, workspace }: { before: unknown; after: unknown; workspace: Workspace }) {
  const normalize = (value: unknown) => {
    if (typeof value === 'string') { try { return JSON.parse(value); } catch { return value; } }
    return value;
  };
  const beforeValue = normalize(before);
  const afterValue = normalize(after);
  const ignored = new Set(['id', 'project_id', 'source_refs', 'field_refs', 'created_at', 'updated_at', 'record_id', 'proposal_id']);
  const preferred = ['title', 'kind', 'owner', 'owner_id', 'role', 'status', 'due', 'baseline_due', 'current_forecast', 'depends_on', 'description', 'member_type', 'evidence_state', 'review_state'];
  const describe = (key: string, value: unknown) => {
    if (value === null || value === undefined || value === '') return 'Neînregistrat';
    if (['due', 'baseline_due', 'current_forecast'].includes(key)) return displayDate(value);
    if (key === 'owner_id') {
      const owner = workspace.members.find((person) => person.id === value)?.title;
      if (owner) return owner;
      const raw = String(value || '');
      return raw.startsWith('candidate:member:') ? titleCase(raw.slice('candidate:member:'.length).replace(/[-_]+/g, ' ')) : 'Responsabil nespecificat';
    }
    if (key === 'depends_on' && Array.isArray(value)) {
      const titles = value.map((id) => [...workspace.tasks, ...workspace.deliverables].find((record) => record.id === id)?.title).filter(Boolean);
      return titles.length ? titles.join(', ') : `${value.length} linked ${value.length === 1 ? 'item' : 'items'}`;
    }
    if (Array.isArray(value)) return `${value.length} recorded ${value.length === 1 ? 'value' : 'values'}`;
    if (['status', 'kind', 'member_type', 'evidence_state', 'review_state'].includes(key)) return titleCase(value);
    return typeof value === 'object' ? 'Detalii consemnate' : safeHistoryText(String(value));
  };
  const isObject = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
  if (isObject(afterValue) && (!beforeValue || isObject(beforeValue))) {
    const beforeObject = isObject(beforeValue) ? beforeValue : {};
    const keys = Array.from(new Set([...Object.keys(beforeObject), ...Object.keys(afterValue)]))
      .filter((key) => !ignored.has(key) && !(key !== 'owner_id' && /(?:^|_)(?:id|ids|ref|refs)$/i.test(key)) && valueText(beforeObject[key]) !== valueText(afterValue[key]));
    const selected = [...preferred.filter((key) => keys.includes(key)), ...keys.filter((key) => !preferred.includes(key))].slice(0, 12);
    return <div className="snapshot-diff">{selected.length ? selected.map((key) => <div className="snapshot-diff-row" key={key}><strong>{titleCase(key)}</strong><span>{describe(key, beforeObject[key])}</span><ArrowRight size={12} /><b>{describe(key, afterValue[key])}</b></div>) : <p>Nu există diferențe salvate pe câmpuri pentru acest eveniment.</p>}</div>;
  }
  return <div className="snapshot-diff"><div className="snapshot-diff-row"><strong>Înainte</strong><span>{safeHistoryText(valueText(beforeValue))}</span><ArrowRight size={12} /><b>{safeHistoryText(valueText(afterValue))}</b></div></div>;
}

function historyTypeLabel(type: string) {
  const labels: Record<string, string> = { project_created: 'Proiect creat', source_added: 'Sursă adăugată', proposal_created: 'Propunere pregătită', proposal_applied: 'Propunere aplicată', proposal_rejected: 'Propunere respinsă', record_created: 'Înregistrare adăugată', record_edited: 'Înregistrare corectată' };
  return labels[type] || titleCase(type);
}

function safeHistoryText(value: unknown) {
  return String(value || '')
    .replace(/candidate:(?:member|task|deliverable):[^\s,;]+(?:\s+[^\s,;]+)?/gi, 'o înregistrare propusă')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi, 'înregistrare asociată')
    .replace(/^Added browser-local source: /, 'Sursă adăugată: ')
    .replace(/^Project created: /, 'Proiect creat: ')
    .replace(/^Applied task: /, 'Sarcină aplicată: ')
    .replace(/^Prepared (\d+) pending source-cited changes\.$/, 'Propuneri pregătite cu citate: $1.')
    .replace(/^1 change applied\. Other proposal items still need review\.$/, 'O modificare aplicată. Celelalte afirmații așteaptă revizuirea.')
    .replace(/^Manager applied (\d+) source-grounded changes?\.$/, 'Modificări cu sursă aplicate de manager: $1.');
}

function StatusBadge({ status }: { status?: string | null }) {
  const value = String(status || 'unreviewed');
  const colorClass = /blocked|reject|overdue/i.test(value) ? 'status-red' : /progress|propos|review/i.test(value) ? 'status-amber' : isCompletedStatus(value) || value === 'confirmed' ? 'status-green' : 'status-neutral';
  return <span className={`status-badge ${colorClass}`}><span />{titleCase(value)}</span>;
}

export default App;
