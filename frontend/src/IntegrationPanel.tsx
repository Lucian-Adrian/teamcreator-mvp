import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, Check, Save, Trash2, X } from 'lucide-react';
import { PRESENTATION_DEMO_NAME } from '../../shared/presentation-demo';
import './integration-panel.css';

export type IntegrationId = 'jira' | 'trello' | 'asana' | 'sharepoint' | 'gmail' | 'outlook' | 'claude' | 'chatgpt' | 'codex';
export type IntegrationState = 'available' | 'needs_configuration' | 'connected';

export interface IntegrationStatus {
  state: IntegrationState;
  detail?: string;
  verifiedAt?: string;
}

export interface IntegrationPanelProps {
  projectId: string;
  presentationDemo?: boolean;
  /** Only pass external connections reported and verified by a real host adapter. */
  connections?: Partial<Record<IntegrationId, IntegrationStatus>>;
  provider?: Record<string, unknown> | null;
  storageMode?: 'browser' | 'server';
}

type FieldName = 'siteUrl' | 'projectKey' | 'boardUrl' | 'workspace' | 'project' | 'site' | 'library' | 'account' | 'mailbox' | 'model' | 'environment' | 'profile';
type FieldDefinition = { name: FieldName; label: string; placeholder: string; required: boolean; type?: 'url' | 'email' };
type Descriptor = { id: IntegrationId; label: string; category: 'project' | 'assistant'; subtitle: string; scope: string; guidance: string; fields: FieldDefinition[] };
type LocalConfiguration = { mode: 'configured'; values: Partial<Record<FieldName, string>>; updatedAt: string };
type LocalSettings = Partial<Record<IntegrationId, LocalConfiguration>>;
type IntegrationDisplay = { label: string; className: string };

const descriptors: Descriptor[] = [
  { id: 'jira', label: 'Jira', category: 'project', subtitle: 'Proiecte și sarcini', scope: 'Proiect · {{project}}', guidance: 'Alege site-ul și cheia proiectului.', fields: [{ name: 'siteUrl', label: 'Adresa site-ului', placeholder: 'https://organizație.atlassian.net', required: true, type: 'url' }, { name: 'projectKey', label: 'Cheia proiectului', placeholder: 'ILUM-STRADAL', required: true }] },
  { id: 'trello', label: 'Trello', category: 'project', subtitle: 'Panouri și carduri', scope: 'Panou · {{project}}', guidance: 'Alege panoul și numele lui.', fields: [{ name: 'boardUrl', label: 'Adresa panoului', placeholder: 'https://trello.com/b/…', required: true, type: 'url' }, { name: 'project', label: 'Numele panoului', placeholder: '{{project}}', required: true }] },
  { id: 'asana', label: 'Asana', category: 'project', subtitle: 'Proiecte și activități', scope: 'Proiect · {{project}}', guidance: 'Indică spațiul de lucru și proiectul.', fields: [{ name: 'workspace', label: 'Spațiul de lucru', placeholder: 'Echipa produs', required: true }, { name: 'project', label: 'Proiectul', placeholder: '{{project}}', required: true }] },
  { id: 'sharepoint', label: 'SharePoint', category: 'project', subtitle: 'Documente și biblioteci', scope: 'Documente · {{project}}', guidance: 'Alege site-ul și biblioteca de documente.', fields: [{ name: 'site', label: 'Adresa site-ului', placeholder: 'https://organizație.sharepoint.com/sites/…', required: true, type: 'url' }, { name: 'library', label: 'Biblioteca', placeholder: 'Documente · {{project}}', required: true }] },
  { id: 'gmail', label: 'Gmail', category: 'project', subtitle: 'E-mail și atașamente', scope: 'Etichetă · {{project}}', guidance: 'Indică adresa și eticheta proiectului.', fields: [{ name: 'account', label: 'Cont', placeholder: 'nume@organizație.md', required: true, type: 'email' }, { name: 'mailbox', label: 'Etichetă / dosar', placeholder: '{{project}}', required: true }] },
  { id: 'outlook', label: 'Outlook', category: 'project', subtitle: 'E-mail și atașamente', scope: 'Dosar · {{project}}', guidance: 'Indică adresa și dosarul proiectului.', fields: [{ name: 'account', label: 'Cont', placeholder: 'nume@organizație.md', required: true, type: 'email' }, { name: 'mailbox', label: 'Dosar / cutie poștală', placeholder: '{{project}}', required: true }] },
  { id: 'claude', label: 'Claude', category: 'assistant', subtitle: 'Asistent AI', scope: 'Context · {{project}}', guidance: 'Alege modelul și mediul de lucru.', fields: [{ name: 'model', label: 'Model', placeholder: 'Model disponibil', required: true }, { name: 'environment', label: 'Mediu / profil', placeholder: '{{project}}', required: true }] },
  { id: 'chatgpt', label: 'ChatGPT', category: 'assistant', subtitle: 'Asistent AI', scope: 'Context · {{project}}', guidance: 'Alege modelul și mediul de lucru.', fields: [{ name: 'model', label: 'Model', placeholder: 'Model disponibil', required: true }, { name: 'environment', label: 'Mediu / profil', placeholder: '{{project}}', required: true }] },
  { id: 'codex', label: 'Codex', category: 'assistant', subtitle: 'Asistent de lucru', scope: 'Workspace · {{project}}', guidance: 'Indică profilul și workspace-ul folosite.', fields: [{ name: 'profile', label: 'Profil', placeholder: 'Profil de lucru', required: true }, { name: 'environment', label: 'Workspace / mediu', placeholder: '{{project}}', required: true }] },
];

function providerMatches(provider: Record<string, unknown> | null | undefined, id: IntegrationId): boolean {
  if (!provider) return false;
  const name = `${String(provider.provider || '')} ${String(provider.model || '')}`.toLowerCase();
  if (id === 'claude') return /claude|anthropic/.test(name);
  if (id === 'chatgpt') return /openai|chatgpt|gpt[-_ ]/.test(name);
  if (id === 'codex') return /codex/.test(name);
  return false;
}

function providerStatus(provider: Record<string, unknown> | null | undefined, id: IntegrationId): IntegrationStatus | undefined {
  if (!providerMatches(provider, id) || !provider) return undefined;
  const configured = provider.ai_configured === true || provider.configured === true || ['configured', 'available'].includes(String(provider.status || ''));
  if (!configured || provider.mode === 'degraded') return undefined;
  const verifiedAt = typeof provider.verified_at === 'string' ? provider.verified_at : typeof provider.checked_at === 'string' ? provider.checked_at : undefined;
  return { state: provider.connected === true && (provider.verified === true || Boolean(verifiedAt)) ? 'connected' : 'available', verifiedAt, detail: 'Stare raportată de mediul gazdă.' };
}

function safeConnection(status?: IntegrationStatus): IntegrationStatus | undefined {
  if (status?.state === 'connected' && !status.verifiedAt) return { state: 'available', detail: 'Gazda a indicat configurarea, fără dovada verificării conexiunii.' };
  return status;
}

function settingsKey(projectId: string) { return `teamcreator:integration-settings:v1:${encodeURIComponent(projectId)}`; }

function looksSensitive(value: string): boolean {
  return /(?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|client[_ -]?secret|password|parol[aă]|secret)\s*[:=]|\bsk-[A-Za-z0-9_-]{16,}|\bgh[pousr]_[A-Za-z0-9]{20,}|\bxox[baprs]-[A-Za-z0-9-]{12,}|\bya29\.[A-Za-z0-9_-]{20,}|^[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{20,}$/i.test(value)
    || value.length >= 36 && !/\s/.test(value) && /[a-z]/.test(value) && /[A-Z]/.test(value) && /\d/.test(value);
}

function readSettings(projectId: string): LocalSettings {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(settingsKey(projectId)) || '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const result: LocalSettings = {};
    for (const descriptor of descriptors) {
      const entry = (parsed as Record<string, unknown>)[descriptor.id];
      if (!entry || typeof entry !== 'object') continue;
      const candidate = entry as Record<string, unknown>;
      const values = candidate.values && typeof candidate.values === 'object' ? candidate.values as Record<string, unknown> : {};
      const allowed = new Set(descriptor.fields.map((field) => field.name));
      const clean: Partial<Record<FieldName, string>> = {};
      for (const [key, value] of Object.entries(values)) {
        if (allowed.has(key as FieldName) && typeof value === 'string' && value.length <= 200 && !looksSensitive(value)) clean[key as FieldName] = value;
      }
      if (candidate.mode === 'configured') result[descriptor.id] = { mode: 'configured', values: clean, updatedAt: typeof candidate.updatedAt === 'string' ? candidate.updatedAt : '' };
    }
    return result;
  } catch { return {}; }
}

function writeSettings(projectId: string, settings: LocalSettings): boolean {
  try { window.localStorage.setItem(settingsKey(projectId), JSON.stringify(settings)); return true; }
  catch { return false; }
}

function validateValues(descriptor: Descriptor, values: Partial<Record<FieldName, string>>): string {
  for (const field of descriptor.fields) {
    const value = String(values[field.name] || '').trim();
    if (field.required && !value) return `Completează câmpul „${field.label}”.`;
    if (!value) continue;
    if (looksSensitive(value)) return 'Valoarea seamănă cu un secret sau token. Câmpurile din browser păstrează doar repere de configurare, fără credențiale.';
    if (field.type === 'url') {
      try { const url = new URL(value); if (url.protocol !== 'https:') return `„${field.label}” trebuie să folosească HTTPS.`; }
      catch { return `Introdu o adresă validă pentru „${field.label}”.`; }
    }
    if (field.type === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return `Introdu o adresă validă pentru „${field.label}”.`;
    if (value.length > 200) return `„${field.label}” depășește limita de 200 de caractere.`;
  }
  return '';
}

const logoFiles: Record<IntegrationId, string> = {
  jira: 'jira.ico', trello: 'trello.ico', asana: 'asana.ico', sharepoint: 'sharepoint.svg',
  gmail: 'gmail.ico', outlook: 'outlook.ico', claude: 'claude.png', chatgpt: 'chatgpt.png', codex: 'codex.png',
};

function Logo({ id }: { id: IntegrationId }) {
  return <img src={`/integrations/${logoFiles[id]}`} alt="" aria-hidden="true" draggable={false} />;
}

function labelFor(config: LocalConfiguration | undefined, external: IntegrationStatus | undefined, presentationDemo: boolean): IntegrationDisplay | null {
  const safe = safeConnection(external);
  if (safe?.state === 'connected' && safe.verifiedAt) return { label: 'Conectat · verificat', className: 'is-connected' };
  if (safe?.state === 'available') return { label: 'Disponibil', className: 'is-available' };
  if (config?.mode === 'configured') return { label: 'Setări salvate', className: 'is-saved' };
  return presentationDemo ? null : { label: 'Necesită setări', className: 'is-needs' };
}

export default function IntegrationPanel({ projectId, provider = null, connections = {}, storageMode, presentationDemo = false }: IntegrationPanelProps) {
  const [settings, setSettings] = useState<LocalSettings>(() => readSettings(projectId));
  const [activeId, setActiveId] = useState<IntegrationId | null>(null);
  const [draft, setDraft] = useState<Partial<Record<FieldName, string>>>({});
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const dialogRef = useRef<HTMLElement | null>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const projectLabel = presentationDemo ? PRESENTATION_DEMO_NAME.split(' · ')[0] : 'proiectul curent';

  useEffect(() => { setSettings(readSettings(projectId)); setActiveId(null); }, [projectId]);
  useEffect(() => {
    if (!activeId) {
      const returnFocus = returnFocusRef.current;
      returnFocusRef.current = null;
      if (returnFocus?.isConnected) returnFocus.focus();
      return;
    }
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const dialog = dialogRef.current;
    const firstControl = dialog?.querySelector<HTMLElement>('[data-dialog-autofocus]') || dialog?.querySelector<HTMLElement>('button, input, select, textarea, [tabindex]:not([tabindex="-1"])');
    firstControl?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); setActiveId(null); return; }
      if (event.key !== 'Tab' || !dialog) return;
      const controls = [...dialog.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])')]
        .filter((element) => element.getAttribute('aria-hidden') !== 'true');
      if (!controls.length) { event.preventDefault(); dialog.focus(); return; }
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => { window.removeEventListener('keydown', handleKeyDown); document.body.style.overflow = previousOverflow; };
  }, [activeId]);

  const integrations = useMemo(() => descriptors.map((descriptor) => {
    const external = safeConnection(connections[descriptor.id] || (descriptor.category === 'assistant' ? providerStatus(provider, descriptor.id) : undefined));
    const local = settings[descriptor.id];
    const scope = descriptor.scope.replaceAll('{{project}}', projectLabel);
    return { ...descriptor, external, local, scope, display: labelFor(local, external, presentationDemo) };
  }), [connections, presentationDemo, provider, settings]);
  const active = integrations.find((item) => item.id === activeId) || null;
  const storageLabel = storageMode === 'browser'
    ? 'Proiectul și setările se păstrează în acest browser.'
    : storageMode === 'server'
      ? 'Proiectul este pe server; setările se păstrează în browser.'
      : 'Setările se păstrează în acest browser.';

  const openConfiguration = (id: IntegrationId) => {
    returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setActiveId(id);
    setDraft({ ...(settings[id]?.values || {}) });
    setMessage(''); setError('');
  };
  const persist = (next: LocalSettings) => {
    if (!writeSettings(projectId, next)) { setError('Nu am putut salva în acest browser. Verifică spațiul disponibil sau setările de stocare.'); return false; }
    setSettings(next); setError(''); return true;
  };
  const saveConfiguration = (event: React.FormEvent) => {
    event.preventDefault();
    if (!active) return;
    const validation = validateValues(active, draft);
    if (validation) { setError(validation); return; }
    const cleanValues: Partial<Record<FieldName, string>> = {};
    for (const field of active.fields) cleanValues[field.name] = String(draft[field.name] || '').trim();
    const next = { ...settings, [active.id]: { mode: 'configured' as const, values: cleanValues, updatedAt: new Date().toISOString() } };
    if (persist(next)) setMessage('Setările au fost salvate.');
  };
  const clearConfiguration = () => {
    if (!active) return;
    const next = { ...settings }; delete next[active.id];
    if (persist(next)) { setDraft({}); setMessage('Setările au fost șterse.'); }
  };
  const close = () => { setActiveId(null); setError(''); setMessage(''); };

  return <section className="integration-panel" aria-label="Integrări și furnizori">
    <div className="integration-panel-heading"><div><h2>Integrări</h2><p>Alege serviciile folosite de echipă. {storageLabel}</p></div><span className="integration-option-count">9 servicii</span></div>
    <section className="integration-catalog-group">
      <div className="integration-group-heading"><h3>Proiecte și documente</h3><span>{presentationDemo ? projectLabel : 'Lucru · documente · corespondență'}</span></div>
      <div className="integration-service-grid">{integrations.filter((item) => item.category === 'project').map((item) => <button type="button" className="integration-service-card" key={item.id} onClick={() => openConfiguration(item.id)} aria-label={`Configurează ${item.label}`} aria-haspopup="dialog">
        <span className={`integration-service-logo integration-logo-${item.id}`}><Logo id={item.id} /></span><span className="integration-service-copy"><strong>{item.label}</strong>{item.display && <small className={`integration-state ${item.display.className}`}><i />{item.display.label}</small>}</span><span className="integration-service-subtitle"><span>{presentationDemo ? item.scope : item.subtitle}</span><b>Configurează →</b></span>
      </button>)}</div>
    </section>
    <section className="integration-catalog-group integration-assistant-group">
      <div className="integration-group-heading"><h3>Asistenți AI</h3><span>{presentationDemo ? `Context · ${projectLabel}` : 'Analiză · dezvoltare · documente'}</span></div>
      <div className="integration-service-grid">{integrations.filter((item) => item.category === 'assistant').map((item) => <button type="button" className="integration-service-card" key={item.id} onClick={() => openConfiguration(item.id)} aria-label={`Configurează ${item.label}`} aria-haspopup="dialog">
        <span className={`integration-service-logo integration-logo-${item.id}`}><Logo id={item.id} /></span><span className="integration-service-copy"><strong>{item.label}</strong>{item.display && <small className={`integration-state ${item.display.className}`}><i />{item.display.label}</small>}</span><span className="integration-service-subtitle"><span>{presentationDemo ? item.scope : item.subtitle}</span><b>Configurează →</b></span>
      </button>)}</div>
    </section>
    {active && <div className="integration-dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}>
      <section ref={dialogRef} className="integration-dialog" role="dialog" aria-modal="true" aria-labelledby="integration-dialog-title" aria-describedby="integration-dialog-guidance" tabIndex={-1}>
        <header className="integration-dialog-header"><button type="button" className="integration-dialog-back" onClick={close}><ArrowLeft size={15} />Înapoi</button><button type="button" className="integration-dialog-close" onClick={close} aria-label="Închide"><X size={17} /></button></header>
        <div className="integration-dialog-title"><span className={`integration-service-logo integration-logo-${active.id}`}><Logo id={active.id} /></span><div>{active.display && <span className={`integration-state ${active.display.className}`}><i />{active.display.label}</span>}<h2 id="integration-dialog-title">{active.label}</h2><p>{active.subtitle}</p></div></div>
        <p id="integration-dialog-guidance" className="integration-dialog-guidance">{active.guidance}</p>
        <form className="integration-config-form" onSubmit={saveConfiguration}>
          {active.fields.map((field, index) => <label key={field.name}>{field.label}{field.required && <span aria-hidden="true"> *</span>}<input data-dialog-autofocus={index === 0 ? 'true' : undefined} type={field.type || 'text'} autoComplete="off" maxLength={200} value={draft[field.name] || ''} placeholder={field.placeholder.replaceAll('{{project}}', projectLabel)} onChange={(event) => { setDraft((current) => ({ ...current, [field.name]: event.target.value })); setMessage(''); setError(''); }} required={field.required} /></label>)}
          {error && <div className="integration-form-message is-error" role="alert">{error}</div>}{message && <div className="integration-form-message" role="status"><Check size={15} />{message}</div>}
          <div className="integration-dialog-actions"><button type="button" className="integration-clear-button" onClick={clearConfiguration} disabled={!settings[active.id]}><Trash2 size={15} />Șterge setările</button><button type="submit" className="integration-save-button"><Save size={15} />Salvează</button></div>
        </form>
        {active.external?.state === 'connected' && active.external.verifiedAt && <div className="integration-host-verified"><Check size={15} />Conexiune verificată · {active.external.verifiedAt}</div>}
        <footer className="integration-dialog-footer"><button type="button" onClick={close}>Închide</button></footer>
      </section>
    </div>}
  </section>;
}
