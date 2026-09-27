import React, { useMemo, useState } from 'react';
import { AlertCircle, ArrowRight, CalendarDays, Check, Download, Expand, FileText, Printer, Shrink, Target } from 'lucide-react';
import type { ProjectRecord, ProjectWorkspace, SourceRef } from '../../shared/types';
import type { SimulationOutput } from '../../shared/simulation';
import { buildProjectReport } from './project-report';
import './reports-workspace.css';

type Audience = 'client' | 'sponsor';
export interface ReportsWorkspaceProps {
  workspace: ProjectWorkspace;
  output?: SimulationOutput | null;
  onRunSimulation?: () => void;
  initialAudience?: Audience;
  onOpenSource?: (ref: SourceRef) => void;
}

function dateLabel(value: string | null | undefined) {
  if (!value) return 'De confirmat';
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleDateString('ro-RO', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : value;
}
function reviewed(record: ProjectRecord) { return ['manager_confirmed', 'manager_corrected'].includes(record.review_state); }
function richText(text: string) {
  return text.split(/(\*\*[^*]+\*\*)/g).map((part, index) => part.startsWith('**') ? <strong key={index}>{part.slice(2, -2)}</strong> : part);
}
function sectionsFrom(markdown: string) {
  const result: Array<{ title: string; lines: string[] }> = [];
  for (const line of markdown.split('\n')) {
    if (line.startsWith('## ')) result.push({ title: line.slice(3), lines: [] });
    else if (result.length && line.trim() && !line.startsWith('Ciornă pentru') && !line.startsWith('Valorile simulate')) result[result.length - 1].lines.push(line);
  }
  return result;
}
function SectionBody({ lines, previewLimit }: { lines: string[]; previewLimit?: number }) {
  const renderLine = (raw: string, index: number) => {
    const line = raw.replace(/^\s*-\s*/, '');
    const sourceIndex = line.indexOf('Sursă:');
    const body = sourceIndex >= 0 ? line.slice(0, sourceIndex).trim() : line;
    const source = sourceIndex >= 0 ? line.slice(sourceIndex) : '';
    return <div className={raw.startsWith('- ') ? 'rp-fact' : 'rp-paragraph'} key={index}>{raw.startsWith('- ') && <span className="rp-fact-dot" />}<div>{richText(body)}{source && <small>{source}</small>}</div></div>;
  };
  const visible = previewLimit ? lines.slice(0, previewLimit) : lines;
  const remainder = previewLimit ? lines.slice(previewLimit) : [];
  const remainderCount = remainder.filter((line) => line.startsWith('- ')).length || remainder.length;
  return <div className="rp-section-body">{visible.map(renderLine)}{remainder.length > 0 && <details className="rp-more-facts"><summary>Vezi încă {remainderCount} {remainderCount === 1 ? 'înregistrare' : 'înregistrări'}</summary><div>{remainder.map((raw, index) => renderLine(raw, index + visible.length))}</div></details>}</div>;
}

export default function ReportsWorkspace({ workspace, output = null, onRunSimulation, initialAudience = 'client', onOpenSource }: ReportsWorkspaceProps) {
  const [audience, setAudience] = useState<Audience>(initialAudience);
  const [expanded, setExpanded] = useState(false);
  const [exportMessage, setExportMessage] = useState('');
  const markdown = useMemo(() => {
    const report = buildProjectReport(output, workspace, audience);
    if (audience !== 'client') return report;
    const escape = (value: string) => value.replace(/[\r\n]+/g, ' ').replace(/\|/g, '\\|');
    const milestones = workspace.deliverables.filter(reviewed);
    return report + '\n\n## Următoarele repere\n\n' + (milestones.length ? ['| Livrabil | Termen consemnat | Depinde de |', '| --- | --- | --- |', ...milestones.map(record => `| ${escape(record.title)} | ${escape(dateLabel(record.due || record.current_forecast || record.baseline_due))} | ${escape(record.depends_on.map(id => [...workspace.tasks, ...workspace.deliverables].find(item => item.id === id)?.title || 'Referință necunoscută').join(', ') || 'Nicio dependență consemnată')} |`)].join('\n') : 'Nu există livrabile confirmate în registru.');
  }, [output, workspace, audience]);
  const sections = useMemo(() => sectionsFrom(markdown), [markdown]);
  const scenario = output?.kind === 'simulation_comparison' ? output.scenario : output;
  const confirmed = [...workspace.tasks, ...workspace.deliverables, ...workspace.decisions].filter(reviewed);
  const sourceRefs = Array.from(new Map(confirmed.flatMap(record => record.source_refs).filter(ref => workspace.sources.some(source => source.id === ref.source_id)).map(ref => [ref.source_id, ref])).values());
  const milestones = workspace.deliverables.filter(reviewed);
  const download = () => {
    const url = URL.createObjectURL(new Blob([markdown], { type: 'text/markdown;charset=utf-8' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `teamcreator-${audience}-${workspace.project.name.replace(/[^a-zA-Z0-9ăâîșțĂÂÎȘȚ-]+/g, '-').slice(0, 80)}.md`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setExportMessage('Fișier Markdown pregătit pentru descărcare.');
  };
  const clientSections = [sections[0], sections[1], sections[2]].filter(Boolean);
  const sponsorSections = sections;
  return <section className={`reports-workspace${expanded ? ' rp-expanded' : ''}`} aria-label="Rapoarte de proiect">
    <header className="rp-page-heading"><h1>Rapoarte</h1><div className="rp-page-actions">
      <button type="button" onClick={() => setExpanded(value => !value)}>{expanded ? <Shrink size={17} /> : <Expand size={17} />}{expanded ? 'Închide previzualizarea' : 'Previzualizează'}</button>
      <button type="button" onClick={download}><Download size={17} />Markdown</button>
      <button type="button" className="rp-primary" onClick={() => window.print()}><Printer size={17} />PDF / Imprimare</button>
    </div></header>
    <div className="rp-toolbar">
      <div className="rp-audience"><span>Audiență:</span><div role="group" aria-label="Audiența raportului">{(['client', 'sponsor'] as const).map(value => <button type="button" key={value} aria-pressed={audience === value} className={audience === value ? 'is-selected' : ''} onClick={() => { setAudience(value); setExportMessage(''); }}>{value === 'client' ? 'Client' : 'Sponsor'}</button>)}</div></div>
      <span className="rp-asof"><CalendarDays size={17} />Stare curentă · {dateLabel(workspace.project.updated_at)}</span>
      <span className="rp-content-kind">{audience === 'client' ? 'Progres și următorii pași' : 'Situație și decizie de conducere'}</span>
      <span className="rp-draft"><i />Ciornă</span>
    </div>
    {exportMessage && <p className="rp-export-message" role="status">{exportMessage}</p>}
    <div className="rp-canvas"><article className={`rp-paper rp-paper-${audience}`}>
      <header className="rp-document-heading"><div><img src="/brand/teamcreator-official-black-on-white.png" alt="TeamCreator" /><span>{workspace.project.name}</span></div><span>{audience === 'client' ? 'Raport de progres' : 'Notă de decizie'}<small>{dateLabel(workspace.project.updated_at)}</small></span></header>
      {audience === 'sponsor' && <div className="rp-decision-callout"><AlertCircle size={23} /><span>{scenario ? 'Verifică ipotezele și compară opțiunile înaintea deciziei.' : 'Simularea nu a fost rulată. Informațiile lipsă rămân de confirmat.'}</span>{!scenario && onRunSimulation && <button type="button" onClick={onRunSimulation}>Deschide simularea <ArrowRight size={15} /></button>}</div>}
      <div className="rp-document-grid">
        {(audience === 'client' ? clientSections : sponsorSections).map((section, index) => <section className={`rp-document-section rp-section-${index % 4}`} key={section.title}>
          <h2><span>{String(index + 1).padStart(2, '0')}</span>{audience === 'client' ? ['Livrat și confirmat', 'În lucru și planificat', 'Avem nevoie de confirmare'][index] : section.title}</h2>
          <SectionBody lines={section.lines} previewLimit={audience === 'client' && section.title === 'Angajamente și livrabile următoare' ? 2 : undefined} />
        </section>)}
        {audience === 'client' && <section className="rp-document-section rp-section-3"><h2><span>04</span>Următoarele repere</h2><p className="rp-section-intro">Livrabile revizuite de manager și dependențele lor.</p>
          {milestones.length ? <>
            <div className="rp-table-scroll"><table><thead><tr><th>Livrabil</th><th>Termen consemnat</th><th>Depinde de</th></tr></thead><tbody>{milestones.slice(0, 3).map(record => <tr key={record.id}><td>{record.title}</td><td>{dateLabel(record.due || record.current_forecast || record.baseline_due)}</td><td>{record.depends_on.map(id => [...workspace.tasks, ...workspace.deliverables].find(item => item.id === id)?.title || 'Referință necunoscută').join(', ') || 'Nicio dependență consemnată'}</td></tr>)}</tbody></table></div>
            {milestones.length > 3 && <details className="rp-more-facts rp-more-milestones"><summary>Vezi încă {milestones.length - 3} {milestones.length - 3 === 1 ? 'reper' : 'repere'}</summary><div className="rp-table-scroll"><table><thead><tr><th>Livrabil</th><th>Termen consemnat</th><th>Depinde de</th></tr></thead><tbody>{milestones.slice(3).map(record => <tr key={record.id}><td>{record.title}</td><td>{dateLabel(record.due || record.current_forecast || record.baseline_due)}</td><td>{record.depends_on.map(id => [...workspace.tasks, ...workspace.deliverables].find(item => item.id === id)?.title || 'Referință necunoscută').join(', ') || 'Nicio dependență consemnată'}</td></tr>)}</tbody></table></div></details>}
          </> : <p className="rp-unknown"><Target size={18} />Nu există livrabile confirmate în registru.</p>}
        </section>}
      </div>
      <footer className="rp-document-footer"><div><Check size={14} />Pregătit din contextul proiectului <span>De revizuit</span></div><div className="rp-document-sources"><FileText size={14} />Surse: {sourceRefs.length ? sourceRefs.map(ref => { const source = workspace.sources.find(item => item.id === ref.source_id)!; return onOpenSource ? <button key={ref.source_id} type="button" onClick={() => onOpenSource(ref)}>{source.name}</button> : <span key={ref.source_id}>{source.name}</span>; }) : 'Nicio sursă atașată'}</div></footer>
      {audience === 'sponsor' && scenario && <p className="rp-model-note">Rezultat condiționat de ipoteze · model {scenario.modelVersion} · seed {scenario.seed} · {scenario.iterations.toLocaleString('ro-RO')} rulări · config {scenario.configFingerprint.slice(0, 12)}. Nu reprezintă un angajament de livrare.</p>}
    </article></div>
    <p className="rp-document-caption">{workspace.project.synthetic ? 'Proiect demonstrativ sintetic' : 'Date din proiect'} · Verifică raportul înainte de trimitere. PDF folosește dialogul de imprimare al browserului.</p>
  </section>;
}
