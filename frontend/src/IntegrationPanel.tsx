import React, { useMemo, useState } from 'react';
import { Check, CircleHelp, LockKeyhole, X } from 'lucide-react';
import './integration-panel.css';

export type IntegrationId = 'jira' | 'trello' | 'asana' | 'sharepoint' | 'gmail' | 'outlook' | 'claude' | 'chatgpt' | 'codex';
export type IntegrationState = 'available' | 'needs_configuration' | 'connected';

export interface IntegrationStatus {
  state: IntegrationState;
  detail?: string;
  verifiedAt?: string;
}

export interface IntegrationPanelProps {
  provider?: Record<string, unknown> | null;
  /** Only pass external connections reported and verified by a real host adapter. */
  connections?: Partial<Record<IntegrationId, IntegrationStatus>>;
  storageMode?: 'browser' | 'server';
}

interface Descriptor {
  id: IntegrationId;
  label: string;
  short: string;
  category: 'project' | 'assistant';
  subtitle: string;
  requirement: string;
}

const descriptors: Descriptor[] = [
  { id: 'jira', label: 'Jira', short: 'J', category: 'project', subtitle: 'Lucru și sarcini', requirement: 'Conectorul Jira nu este activ în acest spațiu. Sincronizarea cere autorizare pe server, acces verificat la proiect și un test reușit. Nu lipi chei sau tokenuri în browser.' },
  { id: 'trello', label: 'Trello', short: 'T', category: 'project', subtitle: 'Panouri și carduri', requirement: 'Conectorul Trello nu este activ în acest spațiu. Sincronizarea cere autorizare pe server, acces verificat la panou și un test reușit. Nu lipi chei sau tokenuri în browser.' },
  { id: 'asana', label: 'Asana', short: 'A', category: 'project', subtitle: 'Proiecte și sarcini', requirement: 'Conectorul Asana nu este activ în acest spațiu. Pentru conectare este necesar un adaptor autorizat pe server; interfața nu promite sincronizare până la o verificare reușită.' },
  { id: 'sharepoint', label: 'SharePoint', short: 'S', category: 'project', subtitle: 'Documente de proiect', requirement: 'Conectorul SharePoint nu este activ în acest spațiu. Pentru acces sunt necesare autorizare Microsoft și verificarea bibliotecii de documente pe server.' },
  { id: 'gmail', label: 'Gmail', short: 'G', category: 'project', subtitle: 'E-mail și atașamente', requirement: 'Conectorul Gmail nu este activ în acest spațiu. Importul e-mailului cere OAuth cu scopuri limitate și testat pe server. Nu introduce parola sau tokenul aici.' },
  { id: 'outlook', label: 'Outlook', short: 'O', category: 'project', subtitle: 'E-mail și atașamente', requirement: 'Conectorul Outlook nu este activ în acest spațiu. Importul e-mailului cere autorizare Microsoft cu scopuri limitate și testată pe server. Nu introduce parola sau tokenul aici.' },
  { id: 'claude', label: 'Claude', short: 'C', category: 'assistant', subtitle: 'Asistent de analiză', requirement: 'Claude poate fi folosit numai printr-un furnizor configurat și verificat de mediul gazdă. Cheile API nu se salvează în browser.' },
  { id: 'chatgpt', label: 'ChatGPT', short: 'G', category: 'assistant', subtitle: 'Asistent de analiză', requirement: 'ChatGPT/OpenAI poate fi folosit numai printr-un furnizor configurat și verificat de mediul gazdă. Cheile API nu se salvează în browser.' },
  { id: 'codex', label: 'Codex', short: 'X', category: 'assistant', subtitle: 'Asistent de dezvoltare și analiză', requirement: 'Codex poate procesa surse numai când furnizorul din mediul gazdă este configurat și verificat. Cheile API nu se salvează în browser.' },
];

function providerMatches(provider: Record<string, unknown> | null | undefined, id: IntegrationId): boolean {
  if (!provider) return false;
  const name = `${String(provider.provider || '')} ${String(provider.model || '')}`.toLowerCase();
  if (id === 'claude') return /claude|anthropic/.test(name);
  if (id === 'chatgpt') return /openai|chatgpt|gpt[-_ ]/.test(name);
  if (id === 'codex') return /codex/.test(name);
  return false;
}

function providerStatus(provider: Record<string, unknown> | null | undefined, id: IntegrationId): IntegrationStatus | null {
  if (!provider || !providerMatches(provider, id)) return null;
  const configured = provider.ai_configured === true || provider.configured === true || ['configured', 'available'].includes(String(provider.status || ''));
  if (!configured || provider.mode === 'degraded') return null;
  const verifiedAt = typeof provider.verified_at === 'string' ? provider.verified_at : typeof provider.checked_at === 'string' ? provider.checked_at : undefined;
  const connected = provider.connected === true && (provider.verified === true || Boolean(verifiedAt));
  return {
    state: connected ? 'connected' : 'available',
    verifiedAt,
    detail: connected
      ? 'Gazda a raportat o conexiune verificată. Textul surselor se trimite numai după activarea explicită a partajării AI.'
      : 'Furnizorul este configurat de gazdă, dar conexiunea nu este confirmată. Nu se trimit surse fără activarea explicită a partajării AI.',
  };
}

function safeConnection(status: IntegrationStatus | undefined): IntegrationStatus {
  if (!status) return { state: 'needs_configuration' };
  if (status.state === 'connected' && !status.verifiedAt) {
    return { state: 'available', detail: 'Gazda a indicat configurarea, dar nu a furnizat dovada verificării conexiunii.' };
  }
  return status;
}

function stateLabel(state: IntegrationState): string {
  if (state === 'connected') return 'Conectat · verificat';
  if (state === 'available') return 'Disponibil';
  return 'Necesită configurare';
}

export function IntegrationSummaryStrip({ connections = {}, onOpen }: IntegrationPanelProps & { onOpen: () => void }) {
  const compactIds: IntegrationId[] = ['jira', 'sharepoint', 'outlook'];
  return <section className="integration-summary-strip" aria-label="Starea integrărilor">
    <strong>Integrări</strong>
    <div>{compactIds.map((id) => {
      const descriptor = descriptors.find((item) => item.id === id)!;
      const status = safeConnection(connections[id]);
      return <span className={`integration-summary-item integration-state-${status.state}`} key={id}><i />{descriptor.label}<small>{status.state === 'connected' ? 'Verificat' : status.state === 'available' ? 'Disponibil' : 'Neconfigurat'}</small></span>;
    })}</div>
    <button type="button" onClick={onOpen}>Vezi integrările</button>
  </section>;
}

export default function IntegrationPanel({ provider = null, connections = {}, storageMode }: IntegrationPanelProps) {
  const [selectedId, setSelectedId] = useState<IntegrationId>('codex');
  const [showRequirements, setShowRequirements] = useState(false);
  const integrations = useMemo(() => descriptors.map((descriptor) => {
    const status = safeConnection(connections[descriptor.id] || (descriptor.category === 'assistant' ? providerStatus(provider, descriptor.id) || undefined : undefined));
    return { ...descriptor, status };
  }), [connections, provider]);
  const selected = integrations.find((item) => item.id === selectedId) || integrations[0];
  const hasVerifiedConnections = integrations.some((item) => item.status.state === 'connected');
  const selectedVerified = selected.status.state === 'connected';
  const externalStatusText = hasVerifiedConnections
    ? 'Conexiunile confirmate sunt raportate de gazdă.'
    : 'Nu există sincronizări externe verificate în acest spațiu.';

  const renderCard = (item: typeof integrations[number]) => <button type="button" className={`integration-service-card ${selected.id === item.id ? 'integration-service-card-selected' : ''}`} key={item.id} onClick={() => { setSelectedId(item.id); setShowRequirements(false); }} aria-pressed={selected.id === item.id}>
    <span className={`integration-service-logo integration-logo-${item.id}`}>{item.short}</span>
    <span className="integration-service-copy"><strong>{item.label}</strong><small className={`integration-state integration-state-${item.status.state}`}><i />{stateLabel(item.status.state)}</small></span>
    <span className="integration-service-subtitle">{item.subtitle}</span>
  </button>;

  return <div className="integration-workspace">
    <div className="integration-catalog">
      <section className="integration-catalog-group">
        <div className="integration-group-heading"><h2>Surse de proiect</h2><span>Servicii externe pentru lucru și documente</span></div>
        <div className="integration-service-grid">{integrations.filter((item) => item.category === 'project').map(renderCard)}</div>
      </section>
      <section className="integration-catalog-group integration-assistant-group">
        <div className="integration-group-heading"><h2>Agenți și asistenți</h2><span>Furnizori AI configurați de mediul gazdă</span></div>
        <div className="integration-service-grid">{integrations.filter((item) => item.category === 'assistant').map(renderCard)}</div>
      </section>
      {storageMode && <div className="integration-storage-note"><LockKeyhole size={15} /><span>{storageMode === 'browser' ? 'Proiectele și textele surselor sunt păstrate local în acest browser.' : 'Proiectele și textele surselor sunt păstrate de serviciul server al acestui mediu.'}</span></div>}
    </div>
    <aside className="integration-inspector" aria-live="polite">
      <div className="integration-inspector-head"><span className={`integration-service-logo integration-logo-${selected.id}`}>{selected.short}</span><div><h2>{selected.label}</h2><p>{selected.subtitle}</p></div></div>
      <div className={`integration-inspector-status integration-state-${selected.status.state}`}><i />{stateLabel(selected.status.state)}{selected.status.verifiedAt && <small>· {selected.status.verifiedAt}</small>}</div>
      {selected.category === 'assistant' ? <>
        <section className="integration-access-section"><h3>Acces la proiect</h3><p>Acțiunile AI folosesc numai informații permise explicit de manager.</p>
          <div className="integration-access-row"><span className={selectedVerified ? 'integration-access-mark' : 'integration-access-mark is-off'}>{selectedVerified ? <Check size={14} /> : <LockKeyhole size={14} />}</span><span><strong>Citește sursele confirmate</strong><small>{selectedVerified ? 'Numai după activarea partajării AI' : 'Fără acces până la verificarea conexiunii și activarea partajării'}</small></span></div>
          <div className="integration-access-row"><span className={selectedVerified ? 'integration-access-mark' : 'integration-access-mark is-off'}>{selectedVerified ? <Check size={14} /> : <LockKeyhole size={14} />}</span><span><strong>Analizează riscurile</strong><small>{selectedVerified ? 'Rezultatul cere verificarea surselor' : 'Necesită furnizor verificat și partajare AI activă'}</small></span></div>
          <div className="integration-access-row"><span className={selectedVerified ? 'integration-access-mark' : 'integration-access-mark is-off'}>{selectedVerified ? <Check size={14} /> : <LockKeyhole size={14} />}</span><span><strong>Propune sarcini și decizii</strong><small>{selectedVerified ? 'Propunerile rămân în revizuire' : 'Necesită furnizor verificat și partajare AI activă'}</small></span></div>
        </section>
        <div className="integration-review-note"><LockKeyhole size={16} /><span><strong>Modificările se revizuiesc</strong><small>Orice propunere trebuie aprobată de manager înainte de aplicare.</small></span></div>
      </> : <section className="integration-access-section"><h3>Stare sincronizare</h3><p>{selected.status.detail || selected.requirement}</p><div className="integration-review-note"><LockKeyhole size={16} /><span><strong>{selected.status.state === 'connected' ? 'Conexiune verificată de gazdă' : 'Fără sincronizare activă'}</strong><small>{selected.status.state === 'connected' ? 'Starea poate fi folosită numai cât timp gazda o menține verificată.' : 'Importul manual de fișiere rămâne disponibil.'}</small></span></div></section>}
      <button type="button" className="integration-configure-button" onClick={() => setShowRequirements(true)}>{selected.status.state === 'connected' ? 'Vezi detaliile conexiunii' : 'Cerințe de configurare'}</button>
      {showRequirements && <div className="integration-dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setShowRequirements(false); }}>
        <section className="integration-dialog" role="dialog" aria-modal="true" aria-labelledby="integration-dialog-title">
          <div className="integration-dialog-header"><div><span className={`integration-service-logo integration-logo-${selected.id}`}>{selected.short}</span><div><h2 id="integration-dialog-title">{selected.label}</h2><small className={`integration-state integration-state-${selected.status.state}`}><i />{stateLabel(selected.status.state)}</small></div></div><button type="button" className="integration-dialog-close" onClick={() => setShowRequirements(false)} aria-label="Închide detaliile"><X size={17} /></button></div>
          <p>{selected.status.detail || selected.requirement}</p>
          {selected.category === 'assistant' && <div className="integration-dialog-note"><CircleHelp size={15} /><span>Un furnizor configurat nu primește text automat. Partajarea AI rămâne o alegere explicită, separată pentru sesiunea de lucru.</span></div>}
          {selected.status.state === 'needs_configuration' && <div className="integration-dialog-note"><CircleHelp size={15} /><span>Nu există o acțiune de conectare activă în această interfață. Nu introduce credențiale în browser.</span></div>}
          {selected.status.verifiedAt && <small className="integration-verified-at">Verificată de gazdă la {selected.status.verifiedAt}</small>}
          <button type="button" className="integration-dialog-done" onClick={() => setShowRequirements(false)}>Închide</button>
        </section>
      </div>}
    </aside>
    <div className="integration-bottom-note"><span className="integration-bottom-dot" />{externalStatusText}<small>Importă fișierele direct în proiect până când un conector este configurat și verificat.</small></div>
  </div>;
}
