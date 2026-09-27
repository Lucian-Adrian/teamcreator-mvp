import React, { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, Check, Save, Trash2, X } from 'lucide-react';
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
type Descriptor = { id: IntegrationId; label: string; category: 'project' | 'assistant'; subtitle: string; guidance: string; fields: FieldDefinition[] };
type LocalConfiguration = { mode: 'configured' | 'demo'; values: Partial<Record<FieldName, string>>; updatedAt: string };
type LocalSettings = Partial<Record<IntegrationId, LocalConfiguration>>;

const descriptors: Descriptor[] = [
  { id: 'jira', label: 'Jira', category: 'project', subtitle: 'Proiecte și sarcini', guidance: 'Alege site-ul și cheia proiectului pe care le folosește echipa.', fields: [{ name: 'siteUrl', label: 'Adresa site-ului', placeholder: 'https://firma.atlassian.net', required: true, type: 'url' }, { name: 'projectKey', label: 'Cheia proiectului', placeholder: 'ECHIPA', required: true }] },
  { id: 'trello', label: 'Trello', category: 'project', subtitle: 'Panouri și carduri', guidance: 'Indică panoul Trello și numele lui.', fields: [{ name: 'boardUrl', label: 'Adresa panoului', placeholder: 'https://trello.com/b/…', required: true, type: 'url' }, { name: 'project', label: 'Numele panoului', placeholder: 'Planificare echipă', required: true }] },
  { id: 'asana', label: 'Asana', category: 'project', subtitle: 'Proiecte și activități', guidance: 'Indică spațiul de lucru și proiectul vizat.', fields: [{ name: 'workspace', label: 'Spațiul de lucru', placeholder: 'Echipa produs', required: true }, { name: 'project', label: 'Proiectul', placeholder: 'Lansare Q4', required: true }] },
  { id: 'sharepoint', label: 'SharePoint', category: 'project', subtitle: 'Documente și biblioteci', guidance: 'Alege site-ul SharePoint și biblioteca de documente.', fields: [{ name: 'site', label: 'Adresa site-ului', placeholder: 'https://firma.sharepoint.com/sites/…', required: true, type: 'url' }, { name: 'library', label: 'Biblioteca', placeholder: 'Documente de proiect', required: true }] },
  { id: 'gmail', label: 'Gmail', category: 'project', subtitle: 'E-mail și atașamente', guidance: 'Indică contul și eticheta Gmail pe care le folosește proiectul.', fields: [{ name: 'account', label: 'Cont', placeholder: 'nume@firma.test', required: true, type: 'email' }, { name: 'mailbox', label: 'Etichetă / dosar', placeholder: 'TeamCreator', required: true }] },
  { id: 'outlook', label: 'Outlook', category: 'project', subtitle: 'E-mail și atașamente', guidance: 'Indică adresa și dosarul Outlook folosite de proiect.', fields: [{ name: 'account', label: 'Cont', placeholder: 'nume@firma.test', required: true, type: 'email' }, { name: 'mailbox', label: 'Dosar / cutie poștală', placeholder: 'Inbox / Proiect', required: true }] },
  { id: 'claude', label: 'Claude', category: 'assistant', subtitle: 'Asistent AI', guidance: 'Notează modelul și mediul folosit; utilizarea cere o configurație verificată.', fields: [{ name: 'model', label: 'Model', placeholder: 'Model configurat de gazdă', required: true }, { name: 'environment', label: 'Mediu / profil', placeholder: 'Producție, echipă…', required: true }] },
  { id: 'chatgpt', label: 'ChatGPT', category: 'assistant', subtitle: 'Asistent AI', guidance: 'Notează modelul și mediul folosit; utilizarea cere o configurație verificată.', fields: [{ name: 'model', label: 'Model', placeholder: 'Model configurat de gazdă', required: true }, { name: 'environment', label: 'Mediu / profil', placeholder: 'Producție, echipă…', required: true }] },
  { id: 'codex', label: 'Codex', category: 'assistant', subtitle: 'Asistent de lucru', guidance: 'Notează profilul și workspace-ul; utilizarea cere un mediu configurat.', fields: [{ name: 'profile', label: 'Profil', placeholder: 'Profilul gazdei', required: true }, { name: 'environment', label: 'Workspace / mediu', placeholder: 'Workspace-ul proiectului', required: true }] },
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
      if (candidate.mode === 'configured' || candidate.mode === 'demo') result[descriptor.id] = { mode: candidate.mode, values: clean, updatedAt: typeof candidate.updatedAt === 'string' ? candidate.updatedAt : '' };
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

function labelFor(config?: LocalConfiguration, external?: IntegrationStatus, presentationDemo = false): { label: string; className: string; verified: boolean } {
  const safe = safeConnection(external);
  if (safe?.state === 'connected' && safe.verifiedAt) return { label: 'Conectat · verificat', className: 'is-connected', verified: true };
  if (config?.mode === 'demo' || presentationDemo && !config) return { label: 'Demo · fără conexiune', className: 'is-demo', verified: false };
  if (config?.mode === 'configured') return { label: 'Configurație salvată · neverificată', className: 'is-saved', verified: false };
  if (safe?.state === 'available') return { label: 'Disponibil · neverificat', className: 'is-available', verified: false };
  return { label: 'Configurare necesară', className: 'is-needs', verified: false };
}

function demoValues(descriptor: Descriptor): Partial<Record<FieldName, string>> {
  const presets: Record<IntegrationId, Partial<Record<FieldName, string>>> = {
    jira: { siteUrl: 'https://acme-example.atlassian.net', projectKey: 'DEMO' },
    trello: { boardUrl: 'https://trello.com/b/demo-board', project: 'Planificare demo' },
    asana: { workspace: 'Echipa exemplu', project: 'Plan de lucru demo' },
    sharepoint: { site: 'https://acme-example.sharepoint.com/sites/demo', library: 'Documente demo' },
    gmail: { account: 'echipa@example.test', mailbox: 'Proiect demo' },
    outlook: { account: 'echipa@example.test', mailbox: 'Proiect demo' },
    claude: { model: 'Model demonstrativ', environment: 'Mediu demo' },
    chatgpt: { model: 'Model demonstrativ', environment: 'Mediu demo' },
    codex: { profile: 'Profil demonstrativ', environment: 'Workspace demo' },
  };
  return presets[descriptor.id];
}

export default function IntegrationPanel({ projectId, provider = null, connections = {}, storageMode, presentationDemo = false }: IntegrationPanelProps) {
  const [settings, setSettings] = useState<LocalSettings>(() => readSettings(projectId));
  const [activeId, setActiveId] = useState<IntegrationId | null>(null);
  const [draft, setDraft] = useState<Partial<Record<FieldName, string>>>({});
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  useEffect(() => { setSettings(readSettings(projectId)); setActiveId(null); }, [projectId]);
  useEffect(() => {
    if (!activeId) return;
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') setActiveId(null); };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [activeId]);

  const integrations = useMemo(() => descriptors.map((descriptor) => {
    const external = safeConnection(connections[descriptor.id] || (descriptor.category === 'assistant' ? providerStatus(provider, descriptor.id) : undefined));
    const local = settings[descriptor.id] || (presentationDemo ? { mode: 'demo' as const, values: demoValues(descriptor), updatedAt: '' } : undefined);
    return { ...descriptor, external, local, display: labelFor(local, external, presentationDemo) };
  }), [connections, presentationDemo, provider, settings]);
  const active = integrations.find((item) => item.id === activeId) || null;
  const storageLabel = storageMode === 'browser' ? 'Proiectul și setările sunt în acest browser.' : storageMode === 'server' ? 'Proiectul este pe server; setările rămân în browser.' : 'Setările sunt locale acestui browser.';

  const openConfiguration = (id: IntegrationId) => {
    const descriptor = descriptors.find((item) => item.id === id)!;
    setActiveId(id);
    setDraft({ ...(settings[id]?.values || (presentationDemo ? demoValues(descriptor) : {})) });
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
    if (persist(next)) setMessage('Configurația locală a fost salvată. Conexiunea și sincronizarea nu au fost verificate.');
  };
  const setDemo = () => {
    if (!active) return;
    const next = { ...settings, [active.id]: { mode: 'demo' as const, values: demoValues(active), updatedAt: new Date().toISOString() } };
    if (persist(next)) { setDraft(demoValues(active)); setMessage('Valori demonstrative salvate. Nu există conexiune sau sincronizare reală.'); }
  };
  const clearConfiguration = () => {
    if (!active) return;
    const next = { ...settings }; delete next[active.id];
    if (persist(next)) { setDraft(presentationDemo ? demoValues(active) : {}); setMessage(presentationDemo ? 'Setarea locală a fost ștearsă. Valorile de demonstrație rămân, fără conexiune.' : 'Configurația locală a fost ștearsă.'); }
  };
  const close = () => { setActiveId(null); setError(''); setMessage(''); };

  return <section className="integration-panel" aria-label="Integrări și furnizori">
    <div className="integration-panel-heading"><div><span className="integration-eyebrow">CONEXIUNI DE PROIECT</span><h2>Integrări</h2><p>Alege serviciile echipei. {storageLabel}</p></div><span className="integration-honesty">9 opțiuni</span></div>
    <section className="integration-catalog-group">
      <div className="integration-group-heading"><h3>Proiecte și documente</h3><span>Jira · Trello · Asana · SharePoint · Gmail · Outlook</span></div>
      <div className="integration-service-grid">{integrations.filter((item) => item.category === 'project').map((item) => <button type="button" className="integration-service-card" key={item.id} onClick={() => openConfiguration(item.id)} aria-label={`Configurează ${item.label}`}>
        <span className={`integration-service-logo integration-logo-${item.id}`}><Logo id={item.id} /></span><span className="integration-service-copy"><strong>{item.label}</strong><small className={`integration-state ${item.display.className}`}><i />{item.display.label}</small></span><span className="integration-service-subtitle"><span>{item.subtitle}</span><b>Configurează →</b></span>
      </button>)}</div>
    </section>
    <section className="integration-catalog-group integration-assistant-group">
      <div className="integration-group-heading"><h3>Asistenți AI</h3><span>Acces numai prin mediul gazdă și cu partajare explicită</span></div>
      <div className="integration-service-grid">{integrations.filter((item) => item.category === 'assistant').map((item) => <button type="button" className="integration-service-card" key={item.id} onClick={() => openConfiguration(item.id)} aria-label={`Configurează ${item.label}`}>
        <span className={`integration-service-logo integration-logo-${item.id}`}><Logo id={item.id} /></span><span className="integration-service-copy"><strong>{item.label}</strong><small className={`integration-state ${item.display.className}`}><i />{item.display.label}</small></span><span className="integration-service-subtitle"><span>{item.subtitle}</span><b>Configurează →</b></span>
      </button>)}</div>
    </section>
    {active && <div className="integration-dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}>
      <section className="integration-dialog" role="dialog" aria-modal="true" aria-labelledby="integration-dialog-title" aria-describedby="integration-dialog-guidance">
        <header className="integration-dialog-header"><button type="button" className="integration-dialog-back" onClick={close}><ArrowLeft size={15} />Înapoi</button><button type="button" className="integration-dialog-close" onClick={close} aria-label="Închide"><X size={17} /></button></header>
        <div className="integration-dialog-title"><span className={`integration-service-logo integration-logo-${active.id}`}><Logo id={active.id} /></span><div><span className={`integration-state ${active.display.className}`}><i />{active.display.label}</span><h2 id="integration-dialog-title">{active.label}</h2><p>{active.subtitle}</p></div></div>
        <p id="integration-dialog-guidance" className="integration-dialog-guidance">{active.guidance}</p>
        <form className="integration-config-form" onSubmit={saveConfiguration}>
          {active.fields.map((field) => <label key={field.name}>{field.label}{field.required && <span aria-hidden="true"> *</span>}<input type={field.type || 'text'} autoComplete="off" maxLength={200} value={draft[field.name] || ''} placeholder={field.placeholder} onChange={(event) => { setDraft((current) => ({ ...current, [field.name]: event.target.value })); setMessage(''); setError(''); }} required={field.required} /></label>)}
          {error && <div className="integration-form-message is-error" role="alert">{error}</div>}{message && <div className="integration-form-message" role="status"><Check size={15} />{message}</div>}
          <div className="integration-dialog-actions"><button type="button" className="integration-clear-button" onClick={clearConfiguration} disabled={!settings[active.id]}><Trash2 size={15} />Șterge</button><button type="button" className="integration-demo-button" onClick={setDemo}>Valori demo</button><button type="submit" className="integration-save-button"><Save size={15} />Salvează</button></div>
        </form>
        {active.external?.state === 'connected' && active.external.verifiedAt && <div className="integration-host-verified"><Check size={15} />Gazda a verificat conexiunea: {active.external.verifiedAt}{active.external.detail ? ` · ${active.external.detail}` : ''}</div>}
        {active.external?.detail && <p className="integration-host-detail">{active.external.detail}</p>}
        <footer className="integration-dialog-footer"><span>Configurare locală. Conectarea și sincronizarea nu sunt active.</span><button type="button" onClick={close}>Închide</button></footer>
      </section>
    </div>}
  </section>;
}
