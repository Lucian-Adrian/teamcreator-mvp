import React from 'react';
import { Activity, ArrowLeft, ChevronDown, Download, Folder, LayoutDashboard, Plus, Upload, Users } from 'lucide-react';

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
  onBack: () => void;
  canGoBack: boolean;
  onCreate: () => void;
  onImport: () => void;
  onToggleExport: () => void;
  exportMenu: React.ReactNode;
}

const stages = [
  { id: 'context', label: 'Context', icon: Folder },
  { id: 'map', label: 'Echipă', icon: Users },
  { id: 'simulation', label: 'Simulare', icon: Activity },
  { id: 'diagnostic', label: 'Decizii', icon: LayoutDashboard },
] as const;

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
        aria-label={stage.label}
        aria-current={props.page === stage.id ? 'page' : undefined}
        onClick={() => props.onPageChange(stage.id)}>
        <span className="workflow-tab-number">{String(index + 1).padStart(2, '0')}</span>
        <span className="workflow-tab-icon" aria-hidden="true"><stage.icon size={16} strokeWidth={1.8} /></span>
        <span className="workflow-tab-label">{stage.label}</span>
        <span className="workflow-tab-track" aria-hidden="true"><i /></span>
        {stage.id === 'context' && props.pendingCount > 0 && <span className="workflow-tab-count">{props.pendingCount}</span>}
      </button>)}
    </nav>
    <div className="header-actions">
      <button className="header-back" onClick={props.onBack} disabled={!props.canGoBack} aria-label="Înapoi"><ArrowLeft size={17} /><span>Înapoi</span></button>
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
