import SampledBranchPlot from './SampledBranchMap';
import { useEffect, useRef, useState, type ChangeEvent, type PointerEvent as PointerEventType } from 'react';
import { Activity, AlertCircle, CalendarDays, GitBranch, Check, ChevronDown, ChevronRight, CircleHelp, LoaderCircle, Minus, Play, Plus, RotateCcw, SlidersHorizontal, Trash2, X } from 'lucide-react';
import {
  compareSimulation,
  createCapacityIntervention,
  createDefaultSimulationConfig,
  createDurationIntervention,
  describeSimulationIntervention,
  getSimulationConfigFingerprint,
  getSimulationWorkspaceFingerprint,
  runSimulation,
  simulationWorkspaceInputKey,
  workingDateAtOffset,
  SIMULATION_MODEL_VERSION,
  SimulationValidationError,
  type MemberCapacity,
  type Quantiles,
  type SharedRiskFactor,
  type SimulationComparison,
  type SimulationCalendar,
  type SimulationConfig,
  type SimulationIntervention,
  type SimulationOutput,
  type SimulationPath,
  type SimulationResult,
} from '../../shared/simulation';
import type { ProjectRecord, ProjectWorkspace } from '../../shared/types';
import { isPresentationDemo, createPresentationSimulationConfig } from '../../shared/presentation-demo';
import './simulation.css';

export interface SimulationProps {
  workspace: ProjectWorkspace;
  onResult?: (result: SimulationOutput | null) => void;
  initialIntervention?: SimulationIntervention | null;
  autoRunKey?: string | number;
}

interface SavedSimulation {
  config: SimulationConfig;
  output: SimulationOutput | null;
}

type InterventionMode = 'duration_shift' | 'capacity';

const MIN_ITERATIONS = 100;
const MAX_ITERATIONS = 100_000;
const weekdayOptions = [
  { day: 1, label: 'Lu' }, { day: 2, label: 'Ma' }, { day: 3, label: 'Mi' }, { day: 4, label: 'Jo' },
  { day: 5, label: 'Vi' }, { day: 6, label: 'Sâ' }, { day: 0, label: 'Du' },
];

export default function Simulation({ workspace, onResult, initialIntervention, autoRunKey }: SimulationProps) {
  const [config, setConfig] = useState<SimulationConfig>(() => {
    const defaults = isPresentationDemo(workspace) ? createPresentationSimulationConfig(workspace) : createDefaultSimulationConfig(workspace);
    const saved = readSaved(workspace);
    return saved ? mergeConfig(defaults, saved.config) : defaults;
  });
  const [output, setOutput] = useState<SimulationOutput | null>(() => readSaved(workspace)?.output || null);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [validationDetails, setValidationDetails] = useState<string[]>([]);
  const [selectedPathId, setSelectedPathId] = useState<string | null>(null);
  const [selectedFamily, setSelectedFamily] = useState<SimulationPath['familyId'] | 'all'>('all');
  const [hoveredPathId, setHoveredPathId] = useState<string | null>(null);
  const [selectedStageFocus, setSelectedStageFocus] = useState<{ pathId: string; taskId: string } | null>(null);
  const [interventionMode, setInterventionMode] = useState<InterventionMode>(initialIntervention?.kind || 'duration_shift');
  const [interventionTaskId, setInterventionTaskId] = useState(initialIntervention?.kind === 'duration_shift' ? initialIntervention.taskId : workspace.tasks[0]?.id || '');
  const [interventionDays, setInterventionDays] = useState(initialIntervention?.kind === 'duration_shift' ? initialIntervention.days : -1);
  const [interventionMemberId, setInterventionMemberId] = useState(initialIntervention?.kind === 'capacity' ? initialIntervention.memberId : workspace.members[0]?.id || '');
  const [interventionAvailability, setInterventionAvailability] = useState(initialIntervention?.kind === 'capacity' ? initialIntervention.availabilityFraction : 1);
  const [interventionConcurrency, setInterventionConcurrency] = useState(initialIntervention?.kind === 'capacity' ? initialIntervention.maxConcurrentTasks || 1 : 1);
  const [riskLabel, setRiskLabel] = useState('');
  const [riskProbability, setRiskProbability] = useState(25);
  const [riskMin, setRiskMin] = useState(1.1);
  const [riskMode, setRiskMode] = useState(1.2);
  const [riskMax, setRiskMax] = useState(1.5);
  const [riskTaskIds, setRiskTaskIds] = useState<string[]>(workspace.tasks.slice(0, 1).map((task) => task.id));
  const [currentFingerprints, setCurrentFingerprints] = useState<{ workspace: string; config: string } | null>(null);
  const controller = useRef<AbortController | null>(null);
  const previousAutoRunKey = useRef<string | number | undefined>(undefined);
  const lastNotifiedOutputKey = useRef<string | null>(null);
  const onResultRef = useRef(onResult);
  onResultRef.current = onResult;

  const tasks = workspace.tasks;
  const members = workspace.members;
  const workspaceModelKey = simulationWorkspaceInputKey(workspace);
  const currentResult = output?.kind === 'simulation_comparison' ? output.scenario : output;
  const currentComparison = output?.kind === 'simulation_comparison' ? output : null;
  const outputIsStale = Boolean(output && (!currentFingerprints
    || output.modelVersion !== SIMULATION_MODEL_VERSION
    || output.workspaceFingerprint !== currentFingerprints.workspace
    || output.configFingerprint !== currentFingerprints.config));
  const visibleResult = outputIsStale ? null : currentResult;
  const visibleComparison = outputIsStale ? null : currentComparison;
  const plottedPaths = visibleResult?.paths || [];
  const selectedPath = plottedPaths.find((path) => path.id === selectedPathId) || null;
  const inspectedPath = selectedPath;
  const inspectedStage = inspectedPath && selectedStageFocus?.pathId === inspectedPath.id
    ? inspectedPath.tasks.find((task) => task.id === selectedStageFocus.taskId) || null
    : null;
  const activeTaskCount = tasks.filter((task) => !isCompleted(task)).length;
  const validRiskDraft = Boolean(riskLabel.trim() && riskTaskIds.length && riskProbability >= 0 && riskProbability <= 100 && riskMin >= 1 && riskMin <= riskMode && riskMode <= riskMax);

  useEffect(() => {
    const loaded = readSaved(workspace);
    const defaults = isPresentationDemo(workspace) ? createPresentationSimulationConfig(workspace) : createDefaultSimulationConfig(workspace);
    if (loaded) {
      setConfig(mergeConfig(defaults, loaded.config));
      setOutput(loaded.output);
    } else {
      setConfig(defaults);
      setOutput(null);
    }
    setSelectedPathId(null);
    setSelectedFamily('all');
    setHoveredPathId(null);
    setSelectedStageFocus(null);
    setInterventionTaskId(workspace.tasks[0]?.id || '');
    setInterventionMemberId(workspace.members[0]?.id || '');
    setRiskTaskIds(workspace.tasks.slice(0, 1).map((task) => task.id));
  }, [workspace.project.id]);

  useEffect(() => {
    const defaults = isPresentationDemo(workspace) ? createPresentationSimulationConfig(workspace) : createDefaultSimulationConfig(workspace);
    setConfig((current) => mergeConfig(defaults, current));
  }, [workspace.project.id, workspaceModelKey]);

  useEffect(() => {
    let current = true;
    setCurrentFingerprints(null);
    void Promise.all([getSimulationWorkspaceFingerprint(workspace), getSimulationConfigFingerprint(config)])
      .then(([workspaceFingerprint, configFingerprint]) => {
        if (current) setCurrentFingerprints({ workspace: workspaceFingerprint, config: configFingerprint });
      })
      .catch(() => { if (current) setCurrentFingerprints(null); });
    return () => { current = false; };
  }, [workspaceModelKey, config]);

  useEffect(() => {
    if (!output || !currentFingerprints) return;
    const outputKey = `${output.kind}:${output.generatedAt}:${output.configFingerprint || 'legacy'}`;
    if (outputIsStale) {
      if (lastNotifiedOutputKey.current !== outputKey) onResultRef.current?.(null);
      lastNotifiedOutputKey.current = outputKey;
      return;
    }
    lastNotifiedOutputKey.current = null;
    onResultRef.current?.(output);
  }, [output, currentFingerprints, outputIsStale]);

  useEffect(() => {
    try {
      window.localStorage.setItem(storageKey(workspace.project.id), JSON.stringify({ version: 2, config, output }));
    } catch {
      // Simulation remains usable when browser storage is disabled or full.
    }
  }, [workspace.project.id, config, output]);

  useEffect(() => {
    if (initialIntervention) {
      setInterventionMode(initialIntervention.kind);
      if (initialIntervention.kind === 'duration_shift') {
        setInterventionTaskId(initialIntervention.taskId);
        setInterventionDays(initialIntervention.days);
      } else {
        setInterventionMemberId(initialIntervention.memberId);
        setInterventionAvailability(initialIntervention.availabilityFraction);
        setInterventionConcurrency(initialIntervention.maxConcurrentTasks || 1);
      }
    }
  }, [initialIntervention]);

  useEffect(() => {
    if (autoRunKey == null || previousAutoRunKey.current === autoRunKey || !initialIntervention) return;
    previousAutoRunKey.current = autoRunKey;
    void run('compare', initialIntervention);
  }, [autoRunKey, initialIntervention, config, workspace.project.id]);

  const updateConfig = (updater: (current: SimulationConfig) => SimulationConfig) => {
    setConfig((current) => updater(current));
    setError(null);
    setValidationDetails([]);
  };

  const run = async (kind: 'baseline' | 'compare', suppliedIntervention?: SimulationIntervention) => {
    if (running) return;
    setError(null);
    setValidationDetails([]);
    setRunning(true);
    setProgress(0);
    const runController = new AbortController();
    controller.current = runController;
    const intervention = suppliedIntervention || buildIntervention();
    try {
      const result = kind === 'compare' && intervention
        ? await compareSimulation(workspace, config, intervention, {
          signal: runController.signal,
          onProgress: (value) => setProgress(value.fraction),
        })
        : await runSimulation(workspace, config, {
          signal: runController.signal,
          onProgress: (value) => setProgress(value.fraction),
        });
      setOutput(result);
      setSelectedPathId(null);
      setSelectedFamily('all');
      setHoveredPathId(null);
      setSelectedStageFocus(null);
    } catch (reason) {
      if (reason instanceof Error && reason.name === 'AbortError') return;
      if (reason instanceof SimulationValidationError) {
        setValidationDetails(reason.details);
        setError(reason.message);
      } else {
        setError(reason instanceof Error ? reason.message : 'Simularea nu a putut fi finalizată.');
      }
    } finally {
      if (controller.current === runController) controller.current = null;
      setRunning(false);
    }
  };

  const selectPath = (id: string) => { setSelectedPathId(id); setHoveredPathId(null); setSelectedStageFocus(null); };
  const selectStage = (pathId: string, taskId: string) => { setSelectedPathId(pathId); setHoveredPathId(null); setSelectedStageFocus({ pathId, taskId }); };

  const selectFamily = (familyId: SimulationPath['familyId'] | 'all') => {
    setSelectedFamily(familyId);
    setHoveredPathId(null);
    setSelectedStageFocus(null);
    if (!visibleResult) return;
    const paths = visibleResult.paths.filter((path) => familyId === 'all' || path.familyId === familyId);
    const family = familyId === 'all' ? null : visibleResult.families.find((item) => item.id === familyId);
    const targetDays = family?.completionDays.p50 ?? visibleResult.completionDays.p50;
    const representative = paths.reduce<SimulationPath | null>((closest, path) => !closest || Math.abs(path.completionDays - targetDays) < Math.abs(closest.completionDays - targetDays) ? path : closest, null);
    setSelectedPathId(representative?.id || null);
  };

  const buildIntervention = (): SimulationIntervention | null => {
    if (interventionMode === 'duration_shift') {
      if (!interventionTaskId || !Number.isFinite(interventionDays)) return null;
      return createDurationIntervention(interventionTaskId, interventionDays, `Ajustare durată · ${selectedTask?.title || interventionTaskId}`);
    }
    if (!interventionMemberId || !Number.isFinite(interventionAvailability)) return null;
    return createCapacityIntervention(interventionMemberId, interventionAvailability, `Ajustare capacitate · ${selectedMember?.title || interventionMemberId}`, interventionConcurrency);
  };

  const autoDemoProject = useRef('');
  useEffect(() => {
    if (!isPresentationDemo(workspace) || !currentFingerprints || running || output || autoDemoProject.current === workspace.project.id) return;
    autoDemoProject.current = workspace.project.id;
    void run('baseline');
  }, [workspace.project.id, currentFingerprints, running, output]);

  const selectedTask = tasks.find((task) => task.id === interventionTaskId);
  const selectedMember = members.find((member) => member.id === interventionMemberId);

  const addRisk = () => {
    if (!validRiskDraft) return;
    const risk: SharedRiskFactor = {
      id: `risk-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`,
      label: riskLabel.trim(),
      taskIds: [...riskTaskIds],
      probability: riskProbability / 100,
      durationMultiplier: { min: riskMin, mode: riskMode, max: riskMax },
    };
    updateConfig((current) => ({ ...current, commonRisks: [...current.commonRisks, risk] }));
    setRiskLabel('');
  };

  const cancel = () => controller.current?.abort();

  return (
    <section className="tc-simulation" aria-labelledby="tc-simulation-title">
      <header className="tc-sim-heading">
        <div>
          
          <h2 id="tc-simulation-title">Simulare</h2>
          <p>{visibleResult ? `${visibleResult.iterations.toLocaleString('ro-RO')} de rulări · selectează o ramură pentru detalii` : 'Posibile evoluții ale proiectului, pornind de la planul actual.'}</p>
        </div>
        <div className="tc-sim-heading-actions">{running ? <button className="tc-sim-button tc-sim-quiet" onClick={cancel}><X size={14} /> Oprește</button> : <button className="tc-sim-button tc-sim-primary" onClick={() => void run('baseline')} disabled={!activeTaskCount}><Play size={14} /> {visibleResult ? 'Rulează din nou' : 'Rulează simularea'}</button>}</div>
      </header>

        <div className={`tc-sim-results${visibleComparison ? ' has-comparison' : ''}${visibleResult ? ' has-output' : ''}${running ? ' is-running' : ''}`}>
          {running && <div className="tc-sim-progress" role="status"><div className="tc-sim-progress-top"><LoaderCircle size={15} className="tc-sim-spin" /><strong>{output?.kind === 'simulation_comparison' ? 'Calculez perechea de scenarii' : 'Rulez extragerile Monte Carlo'}</strong><span>{Math.round(progress * 100)}%</span></div><div className="tc-sim-progress-track"><span style={{ width: `${Math.min(100, Math.max(0, progress * 100))}%` }} /></div><small>{config.iterations.toLocaleString('ro-RO')} rulări · seed {config.seed}</small></div>}
          {error && <div className="tc-sim-error"><AlertCircle size={16} /><div><strong>{error}</strong>{validationDetails.length > 0 && <ul>{validationDetails.map((detail, index) => <li key={`${index}-${detail}`}>{detail}</li>)}</ul>}</div></div>}
          {outputIsStale && !running && <div className="tc-sim-stale"><AlertCircle size={16} /><div><strong>Datele proiectului s-au schimbat</strong><span>Rulează din nou pentru a actualiza ramurile.</span></div></div>}
          {(!output || outputIsStale) && !running && <div className="tc-sim-result-empty"><span className="tc-sim-empty-icon"><Activity size={23} /></span><h3>{outputIsStale ? 'Recalculează simularea' : 'Rezultatele apar aici'}</h3><p>Configurează intervalele și capacitatea, apoi rulează simularea pentru a vedea distribuția și traseele eșantionate.</p><button type="button" className="tc-sim-button tc-sim-primary" onClick={() => void run('baseline')} disabled={!activeTaskCount}><Play size={14} /> Rulează {config.iterations.toLocaleString('ro-RO')} simulări</button></div>}
          {visibleResult && <>
            {!inspectedPath && <aside className="tc-sim-card tc-sim-path-inspector-card tc-sim-click-prompt"><span className="tc-sim-prompt-mark"><GitBranch size={26} /></span><h3>Alege o ramură</h3><p>Vezi când se încheie proiectul și ce se întâmplă pe parcurs.</p><div><small>Estimare centrală</small><strong>{formatCalendarDate(visibleResult.completionDates.p50)}</strong></div><small>Poți selecta și un punct pentru detaliile sarcinii.</small></aside>}
            {inspectedPath && <section className="tc-sim-card tc-sim-path-inspector-card" aria-label="Inspectorul traseului selectat">
              <div className="tc-sim-card-heading"><div><div className="tc-sim-eyebrow">{'Scenariu selectat'}</div><h3>{familyDisplayName(inspectedPath.familyId)}</h3><p>{visibleComparison ? `Intervenție testată · ${describeSimulationIntervention(visibleComparison.intervention, workspace)}` : 'Evoluție posibilă a planului actual'}</p></div><button type="button" className="tc-sim-inspector-close" aria-label="Închide scenariul" onClick={() => { setSelectedPathId(null); setSelectedStageFocus(null); setHoveredPathId(null); }}><X size={17} /></button></div>
              <div className="tc-sim-path-facts"><div><span>Finalizare modelată</span><strong>{formatCalendarDate(workingDateAtOffset(visibleResult.config.calendar, inspectedPath.completionDays))}</strong><small>{formatDays(inspectedPath.completionDays)} · zile lucrătoare echivalente</small></div><div><span>Grup de finalizare</span><strong>{familyDisplayName(inspectedPath.familyId)}</strong><small>{deadlineBucketLabel(inspectedPath.deadlineBucket)}</small></div></div>
              {inspectedStage && <div className="tc-sim-inspected-stage"><span>Etapă selectată · {inspectedStage.kind === 'milestone' ? 'milestone' : 'sarcină'}</span><strong>{inspectedStage.title}</strong><small>Start · {formatDays(inspectedStage.startDays)} · {workingDateAtOffset(visibleResult.config.calendar, inspectedStage.startDays)}</small><small>Finalizare · {formatDays(inspectedStage.finishDays)} · {workingDateAtOffset(visibleResult.config.calendar, inspectedStage.finishDays)}</small></div>}
              <details className="tc-sim-path-stages"><summary>Vezi etapele acestui traseu · {inspectedPath.tasks.length}</summary><PathTimeline path={inspectedPath} calendar={visibleResult.config.calendar} /></details>
              <div className="tc-sim-path-provenance">Eșantion #{inspectedPath.iteration + 1} · {visibleResult.iterations.toLocaleString('ro-RO')} iterări · seed {visibleResult.seed} · {visibleComparison ? 'aceleași extrageri în pereche' : 'rulare baseline'}.</div>
            </section>}

            <section className="tc-sim-card tc-sim-path-card">
              <div className="tc-sim-map-label">{visibleComparison ? 'Scenariu cu intervenție' : 'Planul actual'}<span>{plottedPaths.length} trasee reale din simulare</span></div>
              <SampledBranchPlot stages={visibleResult.stages} paths={plottedPaths} selectedPathId={selectedPath?.id || null} hoveredPathId={hoveredPathId} selectedStageId={selectedStageFocus && selectedStageFocus.pathId === selectedPath?.id ? selectedStageFocus.taskId : null} calendar={visibleResult.config.calendar} onSelect={selectPath} onSelectStage={selectStage} onHover={setHoveredPathId} />
              <div className="tc-sim-map-caption">Etape de proiect · ramuri grupate după finalizare <span title="Forma ramurilor este o dispunere vizuală calculată din timpii rulărilor. Poziția verticală nu este o scară de timp sau o cauză a întârzierii.">ⓘ</span></div>
            </section>

            <details className="tc-sim-card tc-sim-outcome tc-sim-global-summary">
              <summary><div><div className="tc-sim-eyebrow">Rezumatul simulării</div><strong>{formatCalendarDate(visibleResult.completionDates.p50)}</strong><span>{formatDays(visibleResult.completionDays.p50)} · {visibleResult.iterations.toLocaleString('ro-RO')} rulări · seed {visibleResult.seed}</span></div><ChevronDown size={16} /></summary>
              <div className="tc-sim-global-summary-content">
                {visibleComparison && <div className="tc-sim-comparison-banner"><div><small>Intervenție testată</small><strong>{describeSimulationIntervention(visibleComparison.intervention, workspace)}</strong></div><div><small>Mai rapidă în model</small><strong>{formatPercent(visibleComparison.probabilityOfFasterFinish)}</strong></div><span>Pereche cu extrageri comune · seed {visibleComparison.baseline.seed} · config {visibleComparison.configFingerprint.slice(0, 12)}. Rezultat modelat, nu efect observat.</span></div>}
                <QuantileCards quantiles={visibleResult.completionDays} dates={visibleResult.completionDates} comparison={visibleComparison} />
                <DeadlineOutlook result={visibleResult} />
                <Histogram result={visibleResult} />
              </div>
            </details>

            {visibleComparison && <section className="tc-sim-card tc-sim-paired-card"><div className="tc-sim-card-heading"><div><h3>Comparație pereche</h3><p>Fiecare scenariu folosește extrageri aleatoare cu același seed.</p></div><ChevronRight size={16} /></div><div className="tc-sim-paired-values"><div><small>Baseline P50</small><strong>{formatDays(visibleComparison.baseline.completionDays.p50)}</strong></div><ChevronRight size={15} /><div><small>Scenariu P50</small><strong>{formatDays(visibleComparison.scenario.completionDays.p50)}</strong></div><div className={visibleComparison.completionDeltaDays.p50 < 0 ? 'tc-sim-delta-positive' : visibleComparison.completionDeltaDays.p50 > 0 ? 'tc-sim-delta-negative' : ''}><small>Diferență P50</small><strong>{formatDays(visibleComparison.completionDeltaDays.p50, true)}</strong></div></div><div className="tc-sim-inline-note"><Activity size={14} /><span>Diferența P10/P50/P80/P90: {formatDays(visibleComparison.completionDeltaDays.p10, true)} / {formatDays(visibleComparison.completionDeltaDays.p50, true)} / {formatDays(visibleComparison.completionDeltaDays.p80, true)} / {formatDays(visibleComparison.completionDeltaDays.p90, true)}. Valorile descriu modelul configurat, nu o promisiune.</span></div></section>}

            <details className="tc-sim-card tc-sim-metrics-card">
              <summary className="tc-sim-card-heading"><div><h3>Detalii de calcul</h3><p>Indicatori derivați din sarcini și dependențe.</p></div><CircleHelp size={16} /></summary>
              <div className="tc-sim-metrics-grid">
                <Metric label="Sarcini simultane P50" value={visibleResult.metrics.maxParallelTasks.p50.toFixed(1)} detail="Proxy de context switching" />
                <Metric label="Coada de capacitate P50" value={formatDays(visibleResult.metrics.capacityQueueDays.p50)} detail="Față de traseul critic modelat" />
                <Metric label="Predări între owners" value={String(visibleResult.metrics.crossOwnerHandoffCount)} detail="Muchii dependente cu owner diferit" />
                <Metric label="Acoperire cu assignments" value={formatPercent(visibleResult.metrics.assignmentCoverage)} detail="Sarcini active cu membru legat" />
              </div>
              <div className="tc-sim-missingness">
                <strong>Ce lipsește sau rămâne ipoteză</strong>
                <span>{visibleResult.missingness.placeholderEstimateTaskIds.length} durate neconfirmate · {visibleResult.missingness.unassignedTaskIds.length} sarcini fără owner legat · {visibleResult.missingness.placeholderCapacityMemberIds.length} capacități neconfirmate · {visibleResult.missingness.unresolvedDependencyTaskIds.length} sarcini cu dependențe nerezolvate</span>
              </div>
            </details>

            <details className="tc-sim-model-notes"><summary>Formule și limite ale modelului</summary><ul>{visibleResult.notes.map((note, index) => <li key={index}>{note}</li>)}</ul></details>
          </>}
        </div>
      <details className="tc-sim-workbench"><summary><SlidersHorizontal size={16} /><span>Ajustează simularea</span><small>Calendar, durate, capacitate și comparații</small><ChevronDown size={15} /></summary>
      <div className="tc-sim-toolbar tc-sim-secondary-settings" aria-label="Setări rapide ale simulării">
        <label>Rulări<input aria-label="Număr de simulări" type="number" min={MIN_ITERATIONS} max={MAX_ITERATIONS} step={100} value={config.iterations} onChange={(event) => updateConfig((current) => ({ ...current, iterations: numberValue(event, current.iterations) }))} /></label>
        <label>Seed<input aria-label="Seed aleatoriu" type="number" min={0} max={4_294_967_295} step={1} value={config.seed} onChange={(event) => updateConfig((current) => ({ ...current, seed: numberValue(event, current.seed) }))} /></label>
        <span className="tc-sim-toolbar-note">Aceleași intrări și seed reproduc perechea de extrageri.</span>
        {running ? <button type="button" className="tc-sim-button tc-sim-quiet" onClick={cancel}><X size={14} /> Anulează</button> : <button type="button" className="tc-sim-button tc-sim-primary" onClick={() => void run('baseline')} disabled={!activeTaskCount}><Play size={14} /> Rulează</button>}
        <details className="tc-sim-assumptions">
          <summary><SlidersHorizontal size={15} /> Calendar, durate și capacitate <ChevronDown size={14} /></summary>
          <div className="tc-sim-assumption-panel">
            <div className="tc-sim-inline-note"><CircleHelp size={14} /><span>Duratele, calendarul, capacitatea și factorii de risc sunt configurări manuale. Revizuiește-le înainte să interpretezi distribuția modelată.</span></div>
            <div className="tc-sim-controls">

          <details className="tc-sim-card tc-sim-advanced">
            <summary className="tc-sim-card-heading"><div><h3>Calendarul simulării</h3><p>Etichetele de dată folosesc începutul, zilele lucrătoare și sărbătorile configurate.</p></div><CalendarDays size={16} /></summary>
            <div className="tc-sim-run-inputs"><label>Data de început<input type="date" value={config.calendar.startDate} onChange={(event) => updateCalendar({ startDate: event.target.value })} /></label><label>Termen țintă<input type="date" value={config.calendar.deadlineDate || ''} onChange={(event) => updateCalendar({ deadlineDate: event.target.value || null })} /></label></div>
            <div className="tc-sim-weekday-picker" role="group" aria-label="Zile lucrătoare">{weekdayOptions.map(({ day, label }) => <label key={day} className={config.calendar.workingWeekdays.includes(day) ? 'selected' : ''}><input type="checkbox" checked={config.calendar.workingWeekdays.includes(day)} onChange={() => updateCalendar({ workingWeekdays: config.calendar.workingWeekdays.includes(day) ? config.calendar.workingWeekdays.filter((item) => item !== day) : [...config.calendar.workingWeekdays, day].sort((a, b) => a - b) })} /><span>{label}</span></label>)}</div>
            <label className="tc-sim-holiday-input">Zile libere · opțional<input value={config.calendar.holidays.join(', ')} onChange={(event) => updateCalendar({ holidays: event.target.value.split(',').map((value) => value.trim()).filter(Boolean) })} placeholder="AAAA-LL-ZZ, separate prin virgulă" /></label>
            <div className="tc-sim-inline-note"><CircleHelp size={14} /><span>O zi de simulare este o zi lucrătoare echivalentă. Finalizarea în timpul primei zile păstrează data de început; weekendurile și zilele libere selectate sunt sărite. Fără termen țintă, distribuția de risc față de termen rămâne necunoscută.</span></div>
          </details>

          <details className="tc-sim-card tc-sim-advanced">
            <summary className="tc-sim-card-heading"><div><h3>Durate de lucru</h3><p>Valori în zile lucrătoare. Confirmă intervalul fiecărei sarcini.</p></div><span className="tc-sim-count">{tasks.length}</span><ChevronRight size={15} className="tc-sim-advanced-chevron" /></summary>
            {!tasks.length && <div className="tc-sim-empty">Adaugă sarcini în hartă pentru a configura duratele.</div>}
            {!!tasks.length && <div className="tc-sim-table-wrap"><table className="tc-sim-table"><thead><tr><th>Sarcină</th><th>Min</th><th>Mod</th><th>Max</th></tr></thead><tbody>
              {tasks.map((task) => {
                const estimate = config.estimates[task.id] || { min: 1, mode: 3, max: 5, basis: 'placeholder' as const, confirmed: false };
                const completed = isCompleted(task);
                return <tr key={task.id}>
                  <td><span className="tc-sim-task-title">{task.title}</span><small className={estimate.confirmed && estimate.basis !== 'placeholder' ? 'tc-sim-basis-confirmed' : 'tc-sim-basis'}>{completed ? 'Finalizată' : estimate.confirmed && estimate.basis !== 'placeholder' ? basisLabel(estimate.basis) : 'Ipoteză neconfirmată'}</small>{sourceTaskDetails(task).map((detail) => <small className="tc-sim-source-detail" key={detail}>{detail}</small>)}</td>
                  {(['min', 'mode', 'max'] as const).map((field) => <td key={field}><input aria-label={`${task.title} · ${field}`} type="number" min={0} step={0.5} disabled={completed} value={estimate[field]} onChange={(event) => updateConfig((current) => ({ ...current, estimates: { ...current.estimates, [task.id]: { ...estimate, [field]: numberValue(event, estimate[field]), basis: 'manager_estimate', confirmed: true } } }))} /></td>)}
                </tr>;
              })}
            </tbody></table></div>}
            {!!tasks.length && <div className="tc-sim-inline-note"><AlertCircle size={14} /><span>Valorile 1 / 3 / 5 sunt puncte de plecare, nu estimări observate. Înlocuiește-le cu intervale revizuite de manager.</span></div>}
          </details>

          <details className="tc-sim-card tc-sim-advanced">
            <summary className="tc-sim-card-heading"><div><h3>Disponibilitate și capacitate</h3><p>Fracția de zi alocată și limita sarcinilor simultane.</p></div><span className="tc-sim-count">{members.length}</span><ChevronRight size={15} className="tc-sim-advanced-chevron" /></summary>
            {!members.length && <div className="tc-sim-empty">Nu sunt membri confirmați. Sarcinile fără responsabil rulează fără constrângere de resurse și sunt marcate ca lipsă.</div>}
            {members.map((member) => {
              const capacity = config.memberCapacity[member.id] || { availabilityFraction: 1, maxConcurrentTasks: 1, confirmed: false };
              return <div className="tc-sim-capacity-row" key={member.id}>
                <div className="tc-sim-capacity-person"><span className="tc-sim-avatar">{initials(member.title)}</span><span><strong>{member.title}</strong><small>{capacity.confirmed ? 'Configurație manager' : 'Presupunere neconfirmată'}</small>{hasFieldSource(member, 'availability_note') && member.availability_note && <small className="tc-sim-source-detail" title={member.availability_note}>Sursă · {member.availability_note}</small>}</span></div>
                <label>Disponibilitate %<input type="number" min={1} max={100} step={5} value={Math.round(capacity.availabilityFraction * 100)} onChange={(event) => updateMember(member.id, { ...capacity, availabilityFraction: numberValue(event, Math.round(capacity.availabilityFraction * 100)) / 100, confirmed: true })} /></label>
                <label>Simultan<input type="number" min={1} max={50} step={1} value={capacity.maxConcurrentTasks} onChange={(event) => updateMember(member.id, { ...capacity, maxConcurrentTasks: numberValue(event, capacity.maxConcurrentTasks), confirmed: true })} /></label>
              </div>;
            })}
            {!!members.length && <div className="tc-sim-inline-note"><CircleHelp size={14} /><span>Disponibilitatea și capacitatea pornesc ca presupuneri de 100% și o sarcină simultană. Verifică valorile înainte să compari intervenții.</span></div>}
          </details>

          <details className="tc-sim-card tc-sim-advanced">
            <summary className="tc-sim-card-heading"><div><h3>Factori comuni de risc</h3><p>Același eveniment aleator afectează sarcinile selectate în fiecare rulare.</p></div><span className="tc-sim-count">{config.commonRisks.length}</span><ChevronRight size={15} className="tc-sim-advanced-chevron" /></summary>
            {config.commonRisks.map((factor) => <div className="tc-sim-risk-item" key={factor.id}>
              <div><strong>{factor.label}</strong><small>{Math.round(factor.probability * 100)}% · multiplicator {factor.durationMultiplier.min.toFixed(2)} / {factor.durationMultiplier.mode.toFixed(2)} / {factor.durationMultiplier.max.toFixed(2)} · {factor.taskIds.length} sarcini</small></div>
              <button type="button" className="tc-sim-icon-button" aria-label={`Șterge factorul ${factor.label}`} onClick={() => updateConfig((current) => ({ ...current, commonRisks: current.commonRisks.filter((risk) => risk.id !== factor.id) }))}><Trash2 size={14} /></button>
            </div>)}
            <div className="tc-sim-risk-editor">
              <label>Nume factor<input value={riskLabel} onChange={(event) => setRiskLabel(event.target.value)} placeholder="Ex. întârziere furnizor" /></label>
              <div className="tc-sim-risk-fields">
                <label>Probabilitate %<input type="number" min={0} max={100} value={riskProbability} onChange={(event) => setRiskProbability(numberValue(event, riskProbability))} /></label>
                <label>Multiplicator min<input type="number" min={1} step={0.05} value={riskMin} onChange={(event) => setRiskMin(numberValue(event, riskMin))} /></label>
                <label>Mod<input type="number" min={1} step={0.05} value={riskMode} onChange={(event) => setRiskMode(numberValue(event, riskMode))} /></label>
                <label>Max<input type="number" min={1} step={0.05} value={riskMax} onChange={(event) => setRiskMax(numberValue(event, riskMax))} /></label>
              </div>
              <div className="tc-sim-risk-scope"><strong>Sarcini afectate</strong>{tasks.map((task) => <label key={task.id}><input type="checkbox" checked={riskTaskIds.includes(task.id)} onChange={() => setRiskTaskIds((ids) => ids.includes(task.id) ? ids.filter((id) => id !== task.id) : [...ids, task.id])} />{task.title}</label>)}</div>
              <button type="button" className="tc-sim-button tc-sim-quiet tc-sim-add-risk" onClick={addRisk} disabled={!validRiskDraft}><Plus size={14} /> Adaugă factor comun</button>
            </div>
            <div className="tc-sim-inline-note"><AlertCircle size={14} /><span>Probabilitatea și impactul sunt ipoteze manuale. Factorii suprapuși se compun multiplicativ pe aceeași sarcină.</span></div>
          </details>

          <section className="tc-sim-card tc-sim-intervention-card">
            <div className="tc-sim-card-heading"><div><h3>Testează o intervenție</h3><p>Rezultatul este perechea baseline/scenariu cu aceleași extrageri aleatoare.</p></div><RotateCcw size={15} /></div>
            <label>Tip intervenție<select value={interventionMode} onChange={(event) => setInterventionMode(event.target.value as InterventionMode)}><option value="duration_shift">Ajustare durată</option><option value="capacity">Disponibilitate membru</option></select></label>
            {interventionMode === 'duration_shift' ? <div className="tc-sim-intervention-fields"><label>Sarcină<select value={interventionTaskId} onChange={(event) => setInterventionTaskId(event.target.value)}>{tasks.map((task) => <option key={task.id} value={task.id}>{task.title}</option>)}</select></label><label>Ajustare zile<input type="number" step={0.5} value={interventionDays} onChange={(event) => setInterventionDays(numberValue(event, interventionDays))} /></label></div> : <div className="tc-sim-intervention-fields"><label>Membru<select value={interventionMemberId} onChange={(event) => setInterventionMemberId(event.target.value)}>{members.map((member) => <option key={member.id} value={member.id}>{member.title}</option>)}</select></label><label>Disponibilitate %<input type="number" min={1} max={100} value={Math.round(interventionAvailability * 100)} onChange={(event) => setInterventionAvailability(numberValue(event, interventionAvailability * 100) / 100)} /></label><label>Simultan<input type="number" min={1} max={50} value={interventionConcurrency} onChange={(event) => setInterventionConcurrency(numberValue(event, interventionConcurrency))} /></label></div>}
            <button type="button" className="tc-sim-button tc-sim-compare" onClick={() => void run('compare')} disabled={!activeTaskCount || (interventionMode === 'duration_shift' ? !interventionTaskId : !interventionMemberId) || running}><RotateCcw size={14} /> Compară intervenția</button>
          </section>
            </div>
          </div>
        </details>
        </div>

      </details>
      <div className="tc-sim-footer"><span>Rulări deterministe pe intrările salvate în acest browser.</span><span>{outputIsStale ? 'Ultimul rezultat este depășit' : output ? `Salvat automat · ${new Date(output.generatedAt).toLocaleTimeString('ro-RO', { hour: '2-digit', minute: '2-digit' })}` : 'Niciun rezultat salvat încă'}</span></div>
    </section>
  );

function updateMember(memberId: string, capacity: MemberCapacity) {
    updateConfig((current) => ({ ...current, memberCapacity: { ...current.memberCapacity, [memberId]: capacity } }));
  }

  function updateCalendar(calendarChanges: Partial<SimulationCalendar>) {
    updateConfig((current) => ({ ...current, calendar: { ...current.calendar, ...calendarChanges } }));
  }
}

function QuantileCards({ quantiles, dates, comparison }: { quantiles: Quantiles; dates: SimulationResult['completionDates']; comparison: SimulationComparison | null }) {
  const values: Array<{ label: string; value: number; date: string; key: 'p10' | 'p50' | 'p90'; note: string }> = [
    { label: 'P10 · rapid', value: quantiles.p10, date: dates.p10, key: 'p10', note: '10% dintre rulări s-au terminat până aici' },
    { label: 'P50 · mediană', value: quantiles.p50, date: dates.p50, key: 'p50', note: 'Jumătate dintre rulări s-au terminat până aici' },
    { label: 'P90 · târziu', value: quantiles.p90, date: dates.p90, key: 'p90', note: '90% dintre rulări s-au terminat până aici' },
  ];
  return <div className="tc-sim-quantiles">{values.map((item, index) => <div key={item.label} className={index === 1 ? 'tc-sim-quantile tc-sim-quantile-main' : 'tc-sim-quantile'}><small>{item.label}</small><strong>{item.date}</strong><span>{formatDays(item.value)} · {item.note}</span>{comparison && <em>{comparison.baseline.completionDates[item.key]} baseline</em>}</div>)}</div>;
}

function DeadlineOutlook({ result }: { result: SimulationResult }) {
  const outlook = result.deadlineOutlook;
  if (!outlook) return <div className="tc-sim-deadline-empty"><CalendarDays size={15} /><span>Termenul țintă nu este configurat. Distribuția față de termen rămâne necunoscută.</span></div>;
  const categories = [
    { key: 'onTime', label: 'La termen', value: outlook.onTime, color: 'on-time' },
    { key: 'lateUpTo7Days', label: 'Întârziere 1–7 zile', value: outlook.lateUpTo7Days, color: 'late-week' },
    { key: 'lateMoreThan7Days', label: 'Peste 7 zile', value: outlook.lateMoreThan7Days, color: 'late-long' },
  ] as const;
  const total = categories.reduce((sum, item) => sum + item.value.count, 0);
  return <section className="tc-sim-deadline-outlook" aria-label="Încadrarea simulărilor față de termenul țintă">
    <div className="tc-sim-deadline-heading"><strong>Rezultate față de termen</strong><span>Țintă {outlook.deadlineDate}</span></div>
    <div className="tc-sim-deadline-categories">{categories.map((category) => <div key={category.key} className={`tc-sim-deadline-category ${category.color}`}><span>{category.label}</span><strong>{category.value.count.toLocaleString('ro-RO')}</strong><small>{formatPercent(category.value.share)} din eșantion</small></div>)}</div>
    <small className="tc-sim-deadline-total">Categorii exclusive · {total.toLocaleString('ro-RO')} / {outlook.sampleCount.toLocaleString('ro-RO')} rulări · start {outlook.startDate}</small>
  </section>;
}

function Histogram({ result }: { result: SimulationResult }) {
  const maxCount = Math.max(1, ...result.histogram.map((bin) => bin.count));
  return <div className="tc-sim-histogram-wrap"><div className="tc-sim-histogram-label"><span>Frecvența finalizării</span><small>Fiecare bară numără rulări reale din eșantion</small></div><div className="tc-sim-histogram" role="img" aria-label={`Histogramă pentru ${result.iterations} simulări, P50 ${formatDays(result.completionDays.p50)}`}>
    {result.histogram.map((bin, index) => <div className="tc-sim-histogram-bin" key={index} title={`${bin.count} rulări · ${formatDays(bin.fromDays)}–${formatDays(bin.toDays)}`}><span style={{ height: `${Math.max(2, bin.count / maxCount * 100)}%` }} /><small>{index % Math.max(1, Math.ceil(result.histogram.length / 8)) === 0 ? Math.round(bin.fromDays) : ''}</small></div>)}
  </div><div className="tc-sim-histogram-axis"><span>zile de lucru</span><span>{result.iterations.toLocaleString('ro-RO')} rulări</span></div></div>;
}


function PathTimeline({ path, calendar }: { path: SimulationPath; calendar: SimulationCalendar }) {
  const scale = Math.max(path.completionDays, 0.5);
  return <div className="tc-sim-timeline"><div className="tc-sim-timeline-head"><strong>Etapele traseului</strong><span>Rulare #{path.iteration + 1} · {formatPercentile(path.targetQuantile)} · {formatDays(path.completionDays)} · {workingDateAtOffset(calendar, path.completionDays)}</span></div>{path.tasks.map((task) => {
    const left = Math.min(99, Math.max(0, task.startDays / scale * 100));
    const width = task.durationDays <= 0 ? 1.6 : Math.max(1.6, Math.min(100 - left, task.durationDays / scale * 100));
    return <div className="tc-sim-timeline-row" key={task.id}><span className={task.kind === 'milestone' ? 'tc-sim-timeline-title tc-sim-milestone-label' : 'tc-sim-timeline-title'} title={task.title}>{task.kind === 'milestone' ? '◆ ' : ''}{task.title}</span><div className="tc-sim-timeline-track"><div className={task.kind === 'milestone' ? 'tc-sim-timeline-bar tc-sim-milestone' : 'tc-sim-timeline-bar'} style={{ left: `${left}%`, width: `${width}%` }} title={`${task.title} · ${formatDays(task.startDays)}–${formatDays(task.finishDays)}`}><span /></div></div><small title={workingDateAtOffset(calendar, task.finishDays)}>{workingDateAtOffset(calendar, task.finishDays)}</small></div>;
  })}{!path.tasks.length && <div className="tc-sim-empty">Nu există sarcini în traseul selectat.</div>}</div>;
}

function Metric({ label, value, detail }: { label: string; value: string; detail: string }) {
  return <div className="tc-sim-metric"><span>{label}</span><strong>{value}</strong><small>{detail}</small></div>;
}

function readSaved(workspace: ProjectWorkspace): SavedSimulation | null {
  try {
    const raw = window.localStorage.getItem(storageKey(workspace.project.id));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { version?: number; config?: SimulationConfig; output?: SimulationOutput | null };
    if (!parsed.config || (parsed.version !== 1 && parsed.version !== 2)) return null;
    const output = parsed.output && 'projectId' in parsed.output && parsed.output.projectId === workspace.project.id ? parsed.output : null;
    return { config: parsed.config, output };
  } catch {
    return null;
  }
}

function mergeConfig(defaults: SimulationConfig, saved: SimulationConfig): SimulationConfig {
  const estimates = { ...defaults.estimates, ...(saved.estimates || {}) };
  for (const [taskId, estimate] of Object.entries(defaults.estimates)) {
    if (estimate.basis === 'completed_record') estimates[taskId] = estimate;
  }
  const memberCapacity = { ...defaults.memberCapacity, ...(saved.memberCapacity || {}) };
  for (const [memberId, defaultsForMember] of Object.entries(defaults.memberCapacity)) {
    memberCapacity[memberId] = { ...defaultsForMember, ...(saved.memberCapacity?.[memberId] || {}), availabilityNote: defaultsForMember.availabilityNote };
  }
  return {
    ...defaults,
    ...saved,
    calendar: {
      ...defaults.calendar,
      ...(saved.calendar || {}),
      workingWeekdays: Array.isArray(saved.calendar?.workingWeekdays) ? [...saved.calendar.workingWeekdays] : [...defaults.calendar.workingWeekdays],
      holidays: Array.isArray(saved.calendar?.holidays) ? [...saved.calendar.holidays] : [],
      startDate: typeof saved.calendar?.startDate === 'string' ? saved.calendar.startDate : defaults.calendar.startDate,
      deadlineDate: typeof saved.calendar?.deadlineDate === 'string' ? saved.calendar.deadlineDate : null,
    },
    estimates,
    memberCapacity,
    commonRisks: Array.isArray(saved.commonRisks) ? saved.commonRisks : [],
  };
}

function storageKey(projectId: string): string { return `teamcreator:simulation:v1:${projectId}`; }

function numberValue(event: ChangeEvent<HTMLInputElement>, fallback: number): number {
  const value = Number(event.target.value);
  return Number.isFinite(value) ? value : fallback;
}

function isCompleted(record: ProjectRecord): boolean {
  if (record.completed_at) return true;
  const status = (record.status || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();
  return ['done', 'complete', 'completed', 'finished', 'finalized', 'finalizata', 'terminat', 'terminata', 'livrat', 'incheiat', 'incheiata'].includes(status);
}

function basisLabel(basis: string): string {
  return basis === 'observed' ? 'Date observate' : 'Estimare manager';
}

function hasFieldSource(record: ProjectRecord, field: string): boolean {
  return Boolean(record.field_refs?.[field]?.length);
}

function sourceTaskDetails(task: ProjectRecord): string[] {
  const details: string[] = [];
  if (task.planned_duration_days != null && hasFieldSource(task, 'planned_duration_days')) {
    details.push(`Plan citat: ${task.planned_duration_days} zile · intervalul MC cere confirmare`);
  }
  if (task.effort_hours != null && hasFieldSource(task, 'effort_hours')) details.push(`Efort separat: ${task.effort_hours} h`);
  return details;
}

function formatDays(value: number, signed = false): string {
  const number = Number.isFinite(value) ? value : 0;
  const rounded = Math.round(number * 10) / 10;
  return `${signed && rounded > 0 ? '+' : ''}${rounded.toLocaleString('ro-RO', { maximumFractionDigits: 1 })} zile`;
}

function formatPercent(value: number): string { return `${(Math.round(value * 1000) / 10).toLocaleString('ro-RO', { maximumFractionDigits: 1 })}%`; }

function formatPercentile(value: number): string { return `P${Number.isInteger(value) ? value : value.toFixed(1)}`; }

function familyDisplayName(id: SimulationPath['familyId']): string {
  return id === 'shorter' ? 'Mai devreme' : id === 'central' ? 'Interval central' : 'Mai târziu';
}

function deadlineBucketLabel(bucket: SimulationPath['deadlineBucket']): string {
  if (bucket === 'on_time') return 'la termen sau mai devreme';
  if (bucket === 'late_up_to_7_days') return '1–7 zile calendaristice după termen';
  if (bucket === 'late_more_than_7_days') return 'peste 7 zile calendaristice după termen';
  return 'termen neconfigurat';
}

function initials(value: string): string {
  return value.split(/\s+/).slice(0, 2).map((part) => part[0] || '').join('').toLocaleUpperCase();
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value;
}

function formatCalendarDate(date: string) { return new Date(date + "T12:00:00").toLocaleDateString("ro-RO", { day: "numeric", month: "short", year: "numeric" }); }
