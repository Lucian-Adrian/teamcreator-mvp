import React from 'react';
import { ChevronDown, Download, Plus, Sparkles, Upload } from 'lucide-react';

export type WorkflowPage = 'context' | 'map' | 'simulation' | 'diagnostic';

interface AppHeaderProps {
  projects: { id: string; label: string }[];
  activeId: string;
  page: WorkflowPage;
  pendingCount: number;
  providerText: string;
  providerMessage: string;
  providerDegraded: boolean;
  hasProject: boolean;
  exporting: boolean;
  exportMenuOpen: boolean;
  onProjectChange: (id: string) => void;
  onPageChange: (page: WorkflowPage) => void;
  onCreate: () => void;
  onImport: () => void;
  onToggleExport: () => void;
  exportMenu: React.ReactNode;
}

const stages: { id: WorkflowPage; label: string; accessibleLabel?: string }[] = [
  { id: 'context', label: 'Context' },
  { id: 'map', label: 'Hartă' },
  { id: 'simulation', label: 'Simulare' },
  { id: 'diagnostic', label: 'Decizii', accessibleLabel: 'Decizii și rapoarte' },
];

/** The same project identity, navigation and working actions on every screen. */
export default function AppHeader(props: AppHeaderProps) {
  return <header className="app-header">
    <div className="header-brand-project">
      <img className="brand-logo" src="/brand/teamcreator-official-black-on-white.png" alt="TeamCreator" />
      {props.projects.length > 0 && <label className="project-picker">
        <span className="sr-only">Proiect activ</span>
        <select value={props.activeId} onChange={(event) => props.onProjectChange(event.target.value)}>
          {props.projects.map((project) => <option key={project.id} value={project.id}>{project.label}</option>)}
        </select><ChevronDown size={18} />
      </label>}
    </div>
    <nav className="workflow-tabs" aria-label="Navigarea proiectului">
      {stages.map((stage, index) => <button key={stage.id}
        className={`workflow-tab ${props.page === stage.id ? 'workflow-tab-active' : ''}`}
        aria-label={stage.accessibleLabel || stage.label}
        aria-current={props.page === stage.id ? 'page' : undefined}
        onClick={() => props.onPageChange(stage.id)}>
        <span className="workflow-tab-number">{String(index + 1).padStart(2, '0')}</span>
        <span className="workflow-tab-label">{stage.label}</span>
        <span className="workflow-tab-track" aria-hidden="true"><i /></span>
        {stage.id === 'context' && props.pendingCount > 0 && <span className="workflow-tab-count">{props.pendingCount}</span>}
      </button>)}
    </nav>
    <div className="header-actions">
      <details className="agent-status-menu">
        <summary className="agent-status-trigger" aria-label="Starea agentului">
          <Sparkles size={21} /><span>Agent</span>
          <i className={props.providerDegraded ? 'agent-status-dot is-unavailable' : 'agent-status-dot'} />
        </summary>
        <div className="agent-status-panel">
          <strong>{props.providerText}</strong>
          <p>{props.providerMessage || props.providerText}</p>
          <small>Modificările propuse rămân în revizuire până la decizia managerului.</small>
        </div>
      </details>
      <div className="header-utilities">
        <button className="header-action" title="Creează proiect" aria-label="Proiect" onClick={props.onCreate}><Plus size={20} /></button>
        <button className="header-action" title="Importă surse" aria-label="Importă" onClick={props.onImport} disabled={!props.hasProject}><Upload size={19} /></button>
        <div className="export-menu-wrap">
          <button className="header-action export-trigger" title="Exportă proiectul" aria-label="Export" onClick={props.onToggleExport}
            disabled={!props.hasProject || props.exporting} aria-expanded={props.exportMenuOpen} aria-haspopup="menu"><Download size={19} /></button>
          {props.exportMenu}
        </div>
      </div>
    </div>
  </header>;
}
