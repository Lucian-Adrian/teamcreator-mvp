import type { ProjectRecord, ProjectWorkspace } from './types';

export type EstimateBasis = 'placeholder' | 'manager_estimate' | 'observed' | 'completed_record';

export interface TriangularEstimate {
  min: number;
  mode: number;
  max: number;
  basis: EstimateBasis;
  confirmed: boolean;
  rationale?: string;
}

export interface SharedRiskFactor {
  id: string;
  label: string;
  taskIds: string[];
  probability: number;
  durationMultiplier: { min: number; mode: number; max: number };
  rationale?: string;
}

export interface MemberCapacity {
  availabilityFraction: number;
  maxConcurrentTasks: number;
  confirmed: boolean;
  availabilityNote?: string | null;
}

export interface SimulationConfig {
  iterations: number;
  seed: number;
  calendar: SimulationCalendar;
  estimates: Record<string, TriangularEstimate>;
  commonRisks: SharedRiskFactor[];
  memberCapacity: Record<string, MemberCapacity>;
}

export interface SimulationCalendar {
  startDate: string;
  /** UTC weekday numbers: Sunday 0 through Saturday 6. */
  workingWeekdays: number[];
  holidays: string[];
  deadlineDate: string | null;
}

export type DeadlineBucket = 'on_time' | 'late_up_to_7_days' | 'late_more_than_7_days';

export interface DeadlineOutlook {
  deadlineDate: string;
  startDate: string;
  sampleCount: number;
  onTime: { count: number; share: number };
  lateUpTo7Days: { count: number; share: number };
  lateMoreThan7Days: { count: number; share: number };
}

export type SimulationIntervention =
  | { id?: string; label: string; kind: 'duration_shift'; taskId: string; days: number }
  | { id?: string; label: string; kind: 'capacity'; memberId: string; availabilityFraction: number; maxConcurrentTasks?: number };

export interface SimulationCallbacks {
  signal?: AbortSignal;
  onProgress?: (progress: { completed: number; total: number; fraction: number }) => void;
  chunkSize?: number;
}

export interface Quantiles {
  p10: number;
  p50: number;
  p80: number;
  p90: number;
}

export interface SimulationHistogramBin {
  fromDays: number;
  toDays: number;
  count: number;
  share: number;
}

export interface SimulatedTaskPoint {
  id: string;
  title: string;
  kind: 'task' | 'milestone';
  startDays: number;
  finishDays: number;
  durationDays: number;
}

export interface SimulationPath {
  id: string;
  label: string;
  /** Empirical percentile rank in the full run sample, rounded to 0.1. */
  targetQuantile: number;
  familyId: SimulationFamilyId;
  deadlineBucket: DeadlineBucket | null;
  iteration: number;
  completionDays: number;
  tasks: SimulatedTaskPoint[];
}

export type SimulationFamilyId = 'shorter' | 'central' | 'later';

export interface SimulationFamilySummary {
  id: SimulationFamilyId;
  label: string;
  percentileRange: [number, number];
  sampleCount: number;
  completionDays: Quantiles;
  pathIds: string[];
}

export interface SimulationStageDistribution {
  id: string;
  title: string;
  kind: 'task' | 'milestone';
  finishDays: Quantiles;
}

export interface TaskSimulationSummary {
  taskId: string;
  title: string;
  durationDays: Quantiles;
  finishDays: Quantiles;
  assignedMemberIds: string[];
  estimateConfirmed: boolean;
  hasAssignment: boolean;
}

export interface SimulationResult {
  kind: 'simulation_run';
  projectId: string;
  modelVersion: string;
  workspaceFingerprint: string;
  configFingerprint: string;
  seed: number;
  iterations: number;
  generatedAt: string;
  completionDays: Quantiles;
  completionDates: { p10: string; p50: string; p80: string; p90: string };
  deadlineOutlook: DeadlineOutlook | null;
  histogram: SimulationHistogramBin[];
  families: SimulationFamilySummary[];
  stages: SimulationStageDistribution[];
  tasks: TaskSimulationSummary[];
  paths: SimulationPath[];
  metrics: {
    activeTaskCount: number;
    dependencyCount: number;
    crossOwnerHandoffCount: number;
    assignmentCoverage: number;
    maxParallelTasks: Quantiles;
    capacityQueueDays: Quantiles;
  };
  missingness: {
    placeholderEstimateTaskIds: string[];
    unassignedTaskIds: string[];
    placeholderCapacityMemberIds: string[];
    unresolvedDependencyTaskIds: string[];
  };
  notes: string[];
  config: SimulationConfig;
}

export interface SimulationComparison {
  kind: 'simulation_comparison';
  projectId: string;
  modelVersion: string;
  workspaceFingerprint: string;
  configFingerprint: string;
  generatedAt: string;
  sameRandomDraws: true;
  intervention: SimulationIntervention;
  baseline: SimulationResult;
  scenario: SimulationResult;
  completionDeltaDays: Quantiles;
  probabilityOfFasterFinish: number;
}

export type SimulationOutput = SimulationResult | SimulationComparison;

export const SIMULATION_MODEL_VERSION = '1.2.1';

interface SimNode {
  id: string;
  title: string;
  kind: 'task' | 'milestone';
  record: ProjectRecord;
  dependencies: string[];
  memberIds: string[];
  completed: boolean;
}

interface ScheduledPath {
  completionDays: number;
  points: SimulatedTaskPoint[];
  maxParallelTasks: number;
  criticalPathDays: number;
}

interface InternalRun {
  result: SimulationResult;
  completionSamples: number[];
}

const DEFAULT_ITERATIONS = 10_000;
const MIN_ITERATIONS = 100;
const MAX_ITERATIONS = 100_000;
const MAX_STORED_PATHS = 24;
const MAX_PROGRESS_CHUNK = 500;

export class SimulationValidationError extends Error {
  constructor(message: string, readonly details: string[] = []) {
    super(message);
    this.name = 'SimulationValidationError';
  }
}

export function createDefaultSimulationConfig(workspace: ProjectWorkspace): SimulationConfig {
  const estimates: Record<string, TriangularEstimate> = {};
  for (const task of workspace.tasks) {
    estimates[task.id] = isCompleted(task)
      ? { min: 0, mode: 0, max: 0, basis: 'completed_record', confirmed: true, rationale: 'Înregistrarea este marcată ca finalizată.' }
      : { min: 1, mode: 3, max: 5, basis: 'placeholder', confirmed: false };
  }

  const memberCapacity: Record<string, MemberCapacity> = {};
  for (const member of workspace.members) {
    memberCapacity[member.id] = { availabilityFraction: 1, maxConcurrentTasks: 1, confirmed: false, availabilityNote: member.availability_note || null };
  }

  return {
    iterations: DEFAULT_ITERATIONS,
    seed: 20260927,
    calendar: { startDate: localToday(), workingWeekdays: [1, 2, 3, 4, 5], holidays: [], deadlineDate: null },
    estimates,
    commonRisks: [],
    memberCapacity,
  };
}

/** Maps working-day-equivalent model time to a calendar date using the selected workweek and holidays. */
export function workingDateAtOffset(calendar: SimulationCalendar, workingDays: number): string {
  if (!isCalendarDate(calendar?.startDate) || !Number.isFinite(workingDays) || workingDays < 0) {
    throw new SimulationValidationError('Calendarul sau durata pentru conversia datei nu este validă.');
  }
  const weekdays = new Set(Array.isArray(calendar.workingWeekdays) ? calendar.workingWeekdays : []);
  if (!weekdays.size || [...weekdays].some((day) => !Number.isInteger(day) || day < 0 || day > 6)) {
    throw new SimulationValidationError('Selectează cel puțin o zi lucrătoare validă.');
  }
  const holidays = new Set(Array.isArray(calendar.holidays) ? calendar.holidays : []);
  if ([...holidays].some((date) => !isCalendarDate(date))) throw new SimulationValidationError('O dată liberă din calendar nu este validă.');
  const date = parseUtcDate(calendar.startDate);
  const isWorkday = (value: Date) => weekdays.has(value.getUTCDay()) && !holidays.has(toCalendarDate(value));
  while (!isWorkday(date)) date.setUTCDate(date.getUTCDate() + 1);

  // Completion at day 1 means the end of the first working day, so it keeps the start date label.
  let remaining = Math.max(0, Math.ceil(workingDays - 1e-12) - 1);
  const workingDaysPerWeek = weekdays.size;
  while (remaining > 0) {
    const wholeWeeks = Math.floor(remaining / workingDaysPerWeek);
    if (wholeWeeks > 0) {
      const candidate = new Date(date);
      candidate.setUTCDate(candidate.getUTCDate() + wholeWeeks * 7);
      const crossingHoliday = [...holidays].some((holiday) => {
        if (!weekdays.has(parseUtcDate(holiday).getUTCDay())) return false;
        return holiday > toCalendarDate(date) && holiday <= toCalendarDate(candidate);
      });
      if (!crossingHoliday) {
        date.setTime(candidate.getTime());
        remaining -= wholeWeeks * workingDaysPerWeek;
        continue;
      }
    }
    date.setUTCDate(date.getUTCDate() + 1);
    if (isWorkday(date)) remaining -= 1;
  }
  return toCalendarDate(date);
}

/** Counts disjoint, deadline-relative completion buckets from all simulated completion samples. */
export function summarizeDeadlineOutlook(samples: number[], calendar: SimulationCalendar): DeadlineOutlook | null {
  if (!calendar?.deadlineDate || !isCalendarDate(calendar.deadlineDate) || !samples.length) return null;
  const counts = { onTime: 0, lateUpTo7Days: 0, lateMoreThan7Days: 0 };
  const dateCache = new Map<number, string>();
  for (const sample of samples) {
    const dayIndex = Math.max(0, Math.ceil(sample - 1e-12) - 1);
    let date = dateCache.get(dayIndex);
    if (!date) {
      date = workingDateAtOffset(calendar, sample);
      dateCache.set(dayIndex, date);
    }
    const bucket = getDeadlineBucket(date, calendar.deadlineDate);
    if (bucket === 'on_time') counts.onTime += 1;
    else if (bucket === 'late_up_to_7_days') counts.lateUpTo7Days += 1;
    else if (bucket === 'late_more_than_7_days') counts.lateMoreThan7Days += 1;
  }
  return {
    deadlineDate: calendar.deadlineDate,
    startDate: calendar.startDate,
    sampleCount: samples.length,
    onTime: { count: counts.onTime, share: counts.onTime / samples.length },
    lateUpTo7Days: { count: counts.lateUpTo7Days, share: counts.lateUpTo7Days / samples.length },
    lateMoreThan7Days: { count: counts.lateMoreThan7Days, share: counts.lateMoreThan7Days / samples.length },
  };
}

function quantileDates(quantiles: Quantiles, calendar: SimulationCalendar) {
  return {
    p10: workingDateAtOffset(calendar, quantiles.p10),
    p50: workingDateAtOffset(calendar, quantiles.p50),
    p80: workingDateAtOffset(calendar, quantiles.p80),
    p90: workingDateAtOffset(calendar, quantiles.p90),
  };
}

function localToday(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

function isCalendarDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && toCalendarDate(date) === value;
}

function parseUtcDate(value: string): Date { return new Date(`${value}T00:00:00.000Z`); }
function toCalendarDate(value: Date): string { return value.toISOString().slice(0, 10); }
function addCalendarDays(value: string, days: number): string {
  const date = parseUtcDate(value);
  date.setUTCDate(date.getUTCDate() + days);
  return toCalendarDate(date);
}

function getDeadlineBucket(completionDate: string, deadlineDate: string | null): DeadlineBucket | null {
  if (!deadlineDate) return null;
  if (completionDate <= deadlineDate) return 'on_time';
  return completionDate <= addCalendarDays(deadlineDate, 7) ? 'late_up_to_7_days' : 'late_more_than_7_days';
}

export function createDurationIntervention(taskId: string, days: number, label?: string): SimulationIntervention {
  return { kind: 'duration_shift', taskId, days, label: label || `Ajustează durata cu ${formatSigned(days)} zile` };
}

export function createCapacityIntervention(memberId: string, availabilityFraction: number, label?: string, maxConcurrentTasks?: number): SimulationIntervention {
  return {
    kind: 'capacity', memberId, availabilityFraction,
    ...(maxConcurrentTasks == null ? {} : { maxConcurrentTasks }),
    label: label || 'Ajustează capacitatea disponibilă',
  };
}

export function applySimulationIntervention(config: SimulationConfig, intervention: SimulationIntervention): SimulationConfig {
  const next: SimulationConfig = {
    ...config,
    estimates: { ...config.estimates },
    commonRisks: config.commonRisks.map((risk) => ({ ...risk, taskIds: [...risk.taskIds], durationMultiplier: { ...risk.durationMultiplier } })),
    memberCapacity: Object.fromEntries(Object.entries(config.memberCapacity).map(([id, capacity]) => [id, { ...capacity }])),
  };

  if (intervention.kind === 'duration_shift') {
    const estimate = next.estimates[intervention.taskId];
    if (!estimate) throw new SimulationValidationError(`Nu există o estimare pentru sarcina ${intervention.taskId}.`);
    const min = Math.max(0, estimate.min + intervention.days);
    const mode = Math.max(min, estimate.mode + intervention.days);
    const max = Math.max(mode, estimate.max + intervention.days);
    next.estimates[intervention.taskId] = { ...estimate, min, mode, max };
  } else {
    const previous = next.memberCapacity[intervention.memberId];
    if (!previous) throw new SimulationValidationError(`Nu există capacitate configurată pentru membrul ${intervention.memberId}.`);
    next.memberCapacity[intervention.memberId] = {
      ...previous,
      availabilityFraction: intervention.availabilityFraction,
      ...(intervention.maxConcurrentTasks == null ? {} : { maxConcurrentTasks: intervention.maxConcurrentTasks }),
      confirmed: true,
    };
  }
  return next;
}

export function describeSimulationIntervention(intervention: SimulationIntervention, workspace: ProjectWorkspace): string {
  if (intervention.kind === 'duration_shift') {
    const task = workspace.tasks.find((item) => item.id === intervention.taskId);
    return `${task?.title || 'Sarcină'} · ${formatSigned(intervention.days)} zile lucrătoare`;
  }
  const member = workspace.members.find((item) => item.id === intervention.memberId);
  return `${member?.title || 'Membru'} · disponibilitate ${(intervention.availabilityFraction * 100).toFixed(0)}%${intervention.maxConcurrentTasks == null ? '' : ` · ${intervention.maxConcurrentTasks} sarcini simultane`}`;
}

export function simulationWorkspaceInputKey(workspace: ProjectWorkspace): string {
  const records = [...workspace.tasks, ...workspace.deliverables, ...workspace.members]
    .map((record) => ({
      id: record.id,
      kind: record.kind,
      title: record.title,
      status: record.status,
      owner: record.owner,
      owner_id: record.owner_id,
      due: record.due,
      due_basis: record.due_basis,
      completed_at: record.completed_at,
      planned_start: record.planned_start,
      planned_duration_days: record.planned_duration_days,
      effort_hours: record.effort_hours,
      availability_note: record.availability_note,
      documented_skills: record.documented_skills,
      depends_on: [...(record.depends_on || [])].sort(),
      unresolved_dependencies: [...(record.unresolved_dependencies || [])].sort(),
      evidence_state: record.evidence_state,
      review_state: record.review_state,
      source_refs: sourceRefFingerprint(record.source_refs || []),
      field_refs: Object.fromEntries(Object.entries(record.field_refs || {}).sort(([a], [b]) => a.localeCompare(b)).map(([key, refs]) => [key, sourceRefFingerprint(refs)])),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
  const assignments = workspace.assignments
    .map((assignment) => ({ recordId: assignment.record_id, memberId: assignment.member_id, evidence: assignment.evidence_state, refs: sourceRefFingerprint(assignment.source_refs || []) }))
    .sort((a, b) => `${a.recordId}:${a.memberId}`.localeCompare(`${b.recordId}:${b.memberId}`));
  return JSON.stringify({ projectId: workspace.project.id, records, assignments });
}

export async function getSimulationWorkspaceFingerprint(workspace: ProjectWorkspace): Promise<string> {
  return hashText(simulationWorkspaceInputKey(workspace));
}

export async function getSimulationConfigFingerprint(config: SimulationConfig): Promise<string> {
  const canonical = JSON.stringify({
    iterations: config.iterations,
    seed: config.seed,
    estimates: Object.fromEntries(Object.entries(config.estimates).sort(([a], [b]) => a.localeCompare(b))),
    commonRisks: [...config.commonRisks].map((risk) => ({ ...risk, taskIds: [...risk.taskIds].sort() })).sort((a, b) => a.id.localeCompare(b.id)),
    memberCapacity: Object.fromEntries(Object.entries(config.memberCapacity).sort(([a], [b]) => a.localeCompare(b))),
  });
  return hashText(canonical);
}

export async function runSimulation(workspace: ProjectWorkspace, config: SimulationConfig, callbacks: SimulationCallbacks = {}): Promise<SimulationResult> {
  return (await runInternal(workspace, config, callbacks)).result;
}

export async function compareSimulation(
  workspace: ProjectWorkspace,
  config: SimulationConfig,
  intervention: SimulationIntervention,
  callbacks: SimulationCallbacks = {},
): Promise<SimulationComparison> {
  const baseline = await runInternal(workspace, config, {
    ...callbacks,
    onProgress: (progress) => callbacks.onProgress?.({ ...progress, fraction: progress.fraction * 0.5 }),
  });
  const scenarioConfig = applySimulationIntervention(config, intervention);
  const scenario = await runInternal(workspace, scenarioConfig, {
    ...callbacks,
    onProgress: (progress) => callbacks.onProgress?.({ ...progress, fraction: 0.5 + progress.fraction * 0.5 }),
  });
  const deltas = scenario.completionSamples.map((days, index) => days - baseline.completionSamples[index]);
  callbacks.onProgress?.({ completed: config.iterations, total: config.iterations, fraction: 1 });
  return {
    kind: 'simulation_comparison',
    projectId: workspace.project.id,
    modelVersion: SIMULATION_MODEL_VERSION,
    workspaceFingerprint: baseline.result.workspaceFingerprint,
    configFingerprint: baseline.result.configFingerprint,
    generatedAt: new Date().toISOString(),
    sameRandomDraws: true,
    intervention,
    baseline: baseline.result,
    scenario: scenario.result,
    completionDeltaDays: getQuantiles(deltas),
    probabilityOfFasterFinish: deltas.filter((delta) => delta < -1e-9).length / deltas.length,
  };
}

async function runInternal(workspace: ProjectWorkspace, config: SimulationConfig, callbacks: SimulationCallbacks): Promise<InternalRun> {
  const nodes = buildNodes(workspace);
  validateConfig(workspace, config, nodes);
  const [workspaceFingerprint, configFingerprint] = await Promise.all([
    getSimulationWorkspaceFingerprint(workspace),
    getSimulationConfigFingerprint(config),
  ]);
  const ordered = topologicalOrder(nodes);
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const estimates = config.estimates;
  const random = mulberry32(config.seed >>> 0);
  const completionSamples: number[] = [];
  const taskDurationSamples = new Map<string, number[]>();
  const taskFinishSamples = new Map<string, number[]>();
  const parallelSamples: number[] = [];
  const capacityQueueSamples: number[] = [];
  const pathSamples: Array<{ iteration: number; path: ScheduledPath }> = [];
  const captureEvery = Math.max(1, Math.floor(config.iterations / MAX_STORED_PATHS));
  const chunkSize = Math.min(MAX_PROGRESS_CHUNK, Math.max(1, Math.floor(callbacks.chunkSize || 150)));

  for (let iteration = 0; iteration < config.iterations; iteration += 1) {
    throwIfAborted(callbacks.signal);
    const sampledDurations = new Map<string, number>();
    for (const node of ordered) {
      if (node.kind === 'milestone' || node.completed) {
        sampledDurations.set(node.id, 0);
      } else {
        const estimate = estimates[node.id];
        sampledDurations.set(node.id, sampleTriangular(random(), estimate.min, estimate.mode, estimate.max));
      }
    }

    for (const risk of [...config.commonRisks].sort((a, b) => a.id.localeCompare(b.id))) {
      const occurs = random() < risk.probability;
      const multiplier = occurs
        ? sampleTriangular(random(), risk.durationMultiplier.min, risk.durationMultiplier.mode, risk.durationMultiplier.max)
        : 1;
      if (occurs) for (const taskId of risk.taskIds) sampledDurations.set(taskId, (sampledDurations.get(taskId) || 0) * multiplier);
    }

    const scheduled = schedulePath(ordered, nodeById, sampledDurations, config.memberCapacity);
    completionSamples.push(scheduled.completionDays);
    parallelSamples.push(scheduled.maxParallelTasks);
    capacityQueueSamples.push(Math.max(0, scheduled.completionDays - scheduled.criticalPathDays));
    for (const point of scheduled.points) {
      if (!taskDurationSamples.has(point.id)) taskDurationSamples.set(point.id, []);
      if (!taskFinishSamples.has(point.id)) taskFinishSamples.set(point.id, []);
      taskDurationSamples.get(point.id)!.push(point.durationDays);
      taskFinishSamples.get(point.id)!.push(point.finishDays);
    }
    if (iteration % captureEvery === 0 && pathSamples.length < MAX_STORED_PATHS) pathSamples.push({ iteration, path: scheduled });

    if ((iteration + 1) % chunkSize === 0 || iteration + 1 === config.iterations) {
      callbacks.onProgress?.({ completed: iteration + 1, total: config.iterations, fraction: (iteration + 1) / config.iterations });
      await yieldToBrowser();
    }
  }

  const sortedCompletions = [...completionSamples].sort((a, b) => a - b);
  const completionDays = getQuantilesFromSorted(sortedCompletions);
  const chosenPaths = rankSampledPaths(pathSamples, completionSamples).map((path) => ({
    ...path,
    deadlineBucket: getDeadlineBucket(workingDateAtOffset(config.calendar, path.completionDays), config.calendar.deadlineDate),
  }));
  const families = makeSimulationFamilies(completionSamples, chosenPaths);
  const completionDates = quantileDates(completionDays, config.calendar);
  const deadlineOutlook = summarizeDeadlineOutlook(completionSamples, config.calendar);
  const stages: SimulationStageDistribution[] = ordered.filter((node) => !node.completed).map((node) => ({
    id: node.id,
    title: node.title,
    kind: node.kind,
    finishDays: getQuantiles(taskFinishSamples.get(node.id) || [0]),
  }));
  const activeNodes = nodes.filter((node) => node.kind === 'task' && !node.completed);
  const assignedCount = activeNodes.filter((node) => node.memberIds.length > 0).length;
  const unresolvedDependencyTaskIds = nodes.filter((node) => node.record.unresolved_dependencies?.length).map((node) => node.id);
  const placeholderEstimateTaskIds = activeNodes.filter((node) => estimates[node.id]?.basis === 'placeholder' || !estimates[node.id]?.confirmed).map((node) => node.id);
  const usedMemberIds = new Set(activeNodes.flatMap((node) => node.memberIds));
  const placeholderCapacityMemberIds = [...usedMemberIds].filter((id) => !config.memberCapacity[id]?.confirmed);
  const unresolvedNodes = nodes.filter((node) => node.record.depends_on.some((dependencyId) => !nodeById.has(dependencyId)));
  const taskSummaries = activeNodes.map((node) => ({
    taskId: node.id,
    title: node.title,
    durationDays: getQuantiles(taskDurationSamples.get(node.id) || [0]),
    finishDays: getQuantiles(taskFinishSamples.get(node.id) || [0]),
    assignedMemberIds: node.memberIds,
    estimateConfirmed: Boolean(estimates[node.id]?.confirmed && estimates[node.id]?.basis !== 'placeholder'),
    hasAssignment: node.memberIds.length > 0,
  }));
  const dependencyEdges = nodes.flatMap((node) => node.dependencies.map((dependencyId) => ({ dependent: node, prerequisite: nodeById.get(dependencyId)! })));
  const crossOwnerHandoffCount = dependencyEdges.filter(({ dependent, prerequisite }) => {
    const left = ownerKey(dependent.record);
    const right = ownerKey(prerequisite.record);
    return Boolean(left && right && left !== right);
  }).length;
  const notes = [
    'Duratele sunt zile lucrătoare echivalente din estimări triunghiulare min/mod/probabil/max introduse manual. Rulările sunt deterministe pentru același seed și aceleași intrări.',
    'O estimare triunghiulară modelează intervalul și valoarea cea mai probabilă; nu presupune distribuție normală. Factorii comuni trag un singur eveniment și multiplicator per rulare, apoi îl aplică tuturor sarcinilor selectate.',
    'Sarcinile folosesc dependențele ca prerechizite. Disponibilitatea este fracția de zi alocată proiectului; capacitatea limitează sarcinile simultane per membru, iar sarcinile active împart acea fracție în mod egal.',
    'Când mai multe sarcini pot porni în același timp, ordinea de pornire este după ID stabil. Modelul nu aplică priorități manageriale sau date-limită.',
    'Încărcarea simultană este un proxy de context switching, nu un diagnostic psihologic. Coada de capacitate este diferența față de traseul critic cu aceleași durate și disponibilități, fără competiție între sarcini.',
    'Fricțiunea de predare/aprobare în timp nu este calculată: workspace-ul nu conține istoric validat al duratelor de așteptare. Numărul de predări între responsabili este doar un număr de muchii dependente cu owner diferit.',
    'Livrabilele sunt milestone-uri fără durată. Dependențele nerezolvate în workspace sunt ignorate în calendar și raportate ca lipsă.',
  ];
  const result: SimulationResult = {
    kind: 'simulation_run',
    projectId: workspace.project.id,
    modelVersion: SIMULATION_MODEL_VERSION,
    workspaceFingerprint,
    configFingerprint,
    seed: config.seed,
    iterations: config.iterations,
    generatedAt: new Date().toISOString(),
    completionDays,
    completionDates,
    deadlineOutlook,
    histogram: makeHistogram(completionSamples),
    families,
    stages,
    tasks: taskSummaries,
    paths: chosenPaths,
    metrics: {
      activeTaskCount: activeNodes.length,
      dependencyCount: dependencyEdges.length,
      crossOwnerHandoffCount,
      assignmentCoverage: activeNodes.length ? assignedCount / activeNodes.length : 1,
      maxParallelTasks: getQuantiles(parallelSamples),
      capacityQueueDays: getQuantiles(capacityQueueSamples),
    },
    missingness: {
      placeholderEstimateTaskIds,
      unassignedTaskIds: activeNodes.filter((node) => node.memberIds.length === 0).map((node) => node.id),
      placeholderCapacityMemberIds,
      unresolvedDependencyTaskIds: [...new Set([...unresolvedDependencyTaskIds, ...unresolvedNodes.map((node) => node.id)])],
    },
    notes,
    config: structuredCloneSafe(config),
  };
  return { result, completionSamples };
}

function buildNodes(workspace: ProjectWorkspace): SimNode[] {
  const recordById = new Map<string, ProjectRecord>();
  for (const record of [...workspace.tasks, ...workspace.deliverables]) recordById.set(record.id, record);
  const assignments = new Map<string, Set<string>>();
  for (const assignment of workspace.assignments) {
    if (!assignments.has(assignment.record_id)) assignments.set(assignment.record_id, new Set());
    assignments.get(assignment.record_id)!.add(assignment.member_id);
  }
  return [...workspace.tasks, ...workspace.deliverables].map((record) => {
    const kind = record.kind === 'task' ? 'task' : 'milestone';
    const memberIds = new Set(assignments.get(record.id) || []);
    if (record.owner_id && workspace.members.some((member) => member.id === record.owner_id)) memberIds.add(record.owner_id);
    const ownerName = record.owner;
    if (ownerName) {
      const owner = workspace.members.find((member) => normalize(ownerLabel(member)) === normalize(ownerName));
      if (owner) memberIds.add(owner.id);
    }
    return {
      id: record.id,
      title: record.title,
      kind,
      record,
      dependencies: isCompleted(record) ? [] : record.depends_on.filter((dependencyId) => recordById.has(dependencyId)),
      memberIds: [...memberIds].sort(),
      completed: isCompleted(record),
    };
  });
}

function validateConfig(workspace: ProjectWorkspace, config: SimulationConfig, nodes: SimNode[]): void {
  const errors: string[] = [];
  if (!Number.isInteger(config.iterations) || config.iterations < MIN_ITERATIONS || config.iterations > MAX_ITERATIONS) {
    errors.push(`Numărul de rulări trebuie să fie întreg între ${MIN_ITERATIONS} și ${MAX_ITERATIONS.toLocaleString('ro-RO')}.`);
  }
  if (!Number.isInteger(config.seed) || config.seed < 0 || config.seed > 0xffff_ffff) errors.push('Seed-ul trebuie să fie un întreg între 0 și 4.294.967.295.');
  const calendar = config.calendar;
  if (!calendar || !isCalendarDate(calendar.startDate)) errors.push('Data de început a calendarului trebuie să fie o dată validă.');
  if (!calendar || !Array.isArray(calendar.workingWeekdays) || !calendar.workingWeekdays.length
    || new Set(calendar.workingWeekdays).size !== calendar.workingWeekdays.length
    || calendar.workingWeekdays.some((day) => !Number.isInteger(day) || day < 0 || day > 6)) {
    errors.push('Selectează una sau mai multe zile lucrătoare unice, de duminică 0 până sâmbătă 6.');
  }
  if (!calendar || !Array.isArray(calendar.holidays) || calendar.holidays.some((date) => !isCalendarDate(date))
    || new Set(calendar?.holidays || []).size !== (calendar?.holidays || []).length) {
    errors.push('Datele libere trebuie să fie unice și în formatul AAAA-LL-ZZ.');
  }
  if (calendar?.deadlineDate != null && !isCalendarDate(calendar.deadlineDate)) errors.push('Termenul țintă trebuie să fie gol sau o dată validă.');
  const taskIds = new Set(workspace.tasks.map((task) => task.id));
  for (const node of nodes.filter((item) => item.kind === 'task' && !item.completed)) {
    const estimate = config.estimates?.[node.id];
    if (!estimate) {
      errors.push(`Adaugă o estimare pentru „${node.title}”.`);
      continue;
    }
    if (![estimate.min, estimate.mode, estimate.max].every(Number.isFinite) || estimate.min < 0 || estimate.min > estimate.mode || estimate.mode > estimate.max) {
      errors.push(`Interval invalid pentru „${node.title}”: cere min ≤ mod ≤ max și valori nenegative.`);
    }
  }
  const riskIds = new Set<string>();
  for (const factor of config.commonRisks || []) {
    if (!factor.id.trim() || !factor.label.trim()) errors.push('Fiecare factor comun trebuie să aibă nume și identificator.');
    if (riskIds.has(factor.id)) errors.push(`Identificatorul factorului comun „${factor.id}” este duplicat.`);
    riskIds.add(factor.id);
    if (!Number.isFinite(factor.probability) || factor.probability < 0 || factor.probability > 1) errors.push(`Probabilitate invalidă pentru „${factor.label}”; folosește 0–100%.`);
    const range = factor.durationMultiplier;
    if (!range || ![range.min, range.mode, range.max].every(Number.isFinite) || range.min < 1 || range.min > range.mode || range.mode > range.max) {
      errors.push(`Multiplicator invalid pentru „${factor.label}”: cere min ≤ mod ≤ max și valori de cel puțin 1.`);
    }
    const scopedTaskIds = new Set<string>();
    for (const id of factor.taskIds) {
      if (scopedTaskIds.has(id)) errors.push(`Factorul „${factor.label}” listează de mai multe ori sarcina ${id}.`);
      scopedTaskIds.add(id);
      if (!taskIds.has(id)) errors.push(`Factorul „${factor.label}” referă o sarcină care lipsește (${id}).`);
    }
  }
  for (const member of workspace.members) {
    const capacity = config.memberCapacity?.[member.id];
    if (!capacity) continue;
    if (!Number.isFinite(capacity.availabilityFraction) || capacity.availabilityFraction <= 0 || capacity.availabilityFraction > 1) errors.push(`Disponibilitatea pentru ${member.title} trebuie să fie peste 0% și cel mult 100%.`);
    if (!Number.isInteger(capacity.maxConcurrentTasks) || capacity.maxConcurrentTasks < 1 || capacity.maxConcurrentTasks > 50) errors.push(`Capacitatea simultană pentru ${member.title} trebuie să fie un întreg între 1 și 50.`);
  }
  try { topologicalOrder(nodes); } catch (error) { errors.push(error instanceof Error ? error.message : 'Graful dependențelor nu este valid.'); }
  if (errors.length) throw new SimulationValidationError('Corectează intrările simulării înainte de rulare.', [...new Set(errors)]);
}

function topologicalOrder(nodes: SimNode[]): SimNode[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const indegree = new Map(nodes.map((node) => [node.id, 0]));
  const successors = new Map(nodes.map((node) => [node.id, [] as string[]]));
  for (const node of nodes) {
    for (const dependencyId of node.dependencies) {
      if (!byId.has(dependencyId)) continue;
      indegree.set(node.id, (indegree.get(node.id) || 0) + 1);
      successors.get(dependencyId)!.push(node.id);
    }
  }
  const ready = nodes.filter((node) => indegree.get(node.id) === 0).map((node) => node.id).sort();
  const ordered: SimNode[] = [];
  while (ready.length) {
    const id = ready.shift()!;
    ordered.push(byId.get(id)!);
    for (const successorId of successors.get(id) || []) {
      const next = (indegree.get(successorId) || 0) - 1;
      indegree.set(successorId, next);
      if (next === 0) {
        ready.push(successorId);
        ready.sort();
      }
    }
  }
  if (ordered.length !== nodes.length) {
    const cycleIds = nodes.filter((node) => (indegree.get(node.id) || 0) > 0).map((node) => node.id);
    throw new SimulationValidationError(`Graful dependențelor conține un ciclu (${cycleIds.join(' → ')}). Corectează dependențele înainte de rulare.`);
  }
  return ordered;
}

function schedulePath(
  ordered: SimNode[],
  nodeById: Map<string, SimNode>,
  sampledDurations: Map<string, number>,
  memberCapacity: Record<string, MemberCapacity>,
): ScheduledPath {
  const starts = new Map<string, number>();
  const finishes = new Map<string, number>();
  const completed = new Set<string>();
  const pending = new Set<string>();
  const active = new Set<string>();
  const progress = new Map<string, number>();
  let now = 0;
  let maxParallelTasks = 0;

  for (const node of ordered) {
    if (node.completed) {
      starts.set(node.id, 0);
      finishes.set(node.id, 0);
      completed.add(node.id);
    } else pending.add(node.id);
  }

  while (completed.size < ordered.length) {
    const activeCounts = new Map<string, number>();
    for (const id of active) for (const memberId of nodeById.get(id)!.memberIds) activeCounts.set(memberId, (activeCounts.get(memberId) || 0) + 1);
    let startedAny = false;
    const ready = [...pending].map((id) => nodeById.get(id)!).filter((node) => node.dependencies.every((id) => completed.has(id))).sort((a, b) => a.id.localeCompare(b.id));
    let zeroDurationCompleted = false;
    for (const node of ready) {
      const duration = sampledDurations.get(node.id) || 0;
      if (duration <= 1e-12) {
        starts.set(node.id, now);
        finishes.set(node.id, now);
        pending.delete(node.id);
        completed.add(node.id);
        startedAny = true;
        zeroDurationCompleted = true;
        continue;
      }
      const canStart = node.memberIds.every((memberId) => (activeCounts.get(memberId) || 0) < (memberCapacity[memberId]?.maxConcurrentTasks || 1));
      if (!canStart) continue;
      starts.set(node.id, now);
      pending.delete(node.id);
      active.add(node.id);
      progress.set(node.id, 0);
      for (const memberId of node.memberIds) activeCounts.set(memberId, (activeCounts.get(memberId) || 0) + 1);
      startedAny = true;
    }

    if (zeroDurationCompleted) continue;

    if (active.size === 0) {
      if (completed.size === ordered.length) break;
      if (startedAny) continue;
      throw new SimulationValidationError('Unele sarcini nu pot porni. Verifică dependențele și capacitatea membrilor.');
    }
    maxParallelTasks = Math.max(maxParallelTasks, active.size);
    const rates = new Map<string, number>();
    let nextDelta = Number.POSITIVE_INFINITY;
    for (const id of active) {
      const node = nodeById.get(id)!;
      const rate = node.memberIds.length
        ? Math.min(...node.memberIds.map((memberId) => (memberCapacity[memberId]?.availabilityFraction || 1) / Math.max(1, activeCounts.get(memberId) || 1)))
        : 1;
      rates.set(id, rate);
      const remaining = Math.max(0, (sampledDurations.get(id) || 0) - (progress.get(id) || 0));
      nextDelta = Math.min(nextDelta, remaining / rate);
    }
    if (!Number.isFinite(nextDelta) || nextDelta <= 0) throw new SimulationValidationError('Modelul de capacitate a produs un pas fără progres.');
    now += nextDelta;
    const finishedNow: string[] = [];
    for (const id of active) {
      const nextProgress = (progress.get(id) || 0) + rates.get(id)! * nextDelta;
      progress.set(id, nextProgress);
      if (nextProgress >= (sampledDurations.get(id) || 0) - 1e-8) finishedNow.push(id);
    }
    for (const id of finishedNow) {
      active.delete(id);
      completed.add(id);
      finishes.set(id, now);
    }
  }

  const criticalPath = new Map<string, number>();
  for (const node of ordered) {
    if (node.completed) { criticalPath.set(node.id, 0); continue; }
    const dependencyFinish = node.dependencies.reduce((max, id) => Math.max(max, criticalPath.get(id) || 0), 0);
    const isolatedAvailability = node.memberIds.length
      ? Math.min(...node.memberIds.map((memberId) => memberCapacity[memberId]?.availabilityFraction || 1))
      : 1;
    const rate = Math.max(1e-9, Math.min(1, isolatedAvailability));
    criticalPath.set(node.id, dependencyFinish + (sampledDurations.get(node.id) || 0) / rate);
  }
  const points = ordered.filter((node) => !node.completed).map((node) => ({
    id: node.id,
    title: node.title,
    kind: node.kind,
    startDays: starts.get(node.id) || 0,
    finishDays: finishes.get(node.id) || 0,
    durationDays: sampledDurations.get(node.id) || 0,
  }));
  const completionDays = Math.max(0, ...finishes.values());
  const criticalPathDays = Math.max(0, ...criticalPath.values());
  return { completionDays, points, maxParallelTasks, criticalPathDays };
}

/** Keep a bounded set of real runs and label their actual ranks in the full sample. */
function rankSampledPaths(
  candidates: Array<{ iteration: number; path: ScheduledPath }>,
  completionSamples: number[],
): SimulationPath[] {
  const ranked = completionSamples.map((completion, iteration) => ({ completion, iteration }))
    .sort((left, right) => left.completion - right.completion || left.iteration - right.iteration);
  const rankByIteration = new Map(ranked.map((sample, rank) => [sample.iteration, rank]));
  const firstBoundary = Math.floor(ranked.length / 3);
  const secondBoundary = Math.floor(ranked.length * 2 / 3);
  return [...candidates].sort((left, right) => rankByIteration.get(left.iteration)! - rankByIteration.get(right.iteration)!).map(({ iteration, path }) => {
    const rank = rankByIteration.get(iteration)!;
    const percentile = Math.round(rank / Math.max(1, ranked.length - 1) * 1000) / 10;
    const familyId: SimulationFamilyId = rank < firstBoundary ? 'shorter' : rank < secondBoundary ? 'central' : 'later';
    return {
      id: `run-${iteration}`,
      label: `P${percentile} · ${familyLabel(familyId)}`,
      targetQuantile: percentile,
      familyId,
      deadlineBucket: null,
      iteration,
      completionDays: path.completionDays,
      tasks: path.points,
    };
  });
}

function makeSimulationFamilies(samples: number[], paths: SimulationPath[]): SimulationFamilySummary[] {
  const sorted = [...samples].sort((a, b) => a - b);
  const boundaries = [0, Math.floor(sorted.length / 3), Math.floor((sorted.length * 2) / 3), sorted.length];
  const definitions: Array<{ id: SimulationFamilyId; percentileRange: [number, number] }> = [
    { id: 'shorter', percentileRange: [0, 33] },
    { id: 'central', percentileRange: [33, 67] },
    { id: 'later', percentileRange: [67, 100] },
  ];
  return definitions.map((definition, index) => {
    const values = sorted.slice(boundaries[index], Math.max(boundaries[index] + 1, boundaries[index + 1]));
    const familyPaths = paths.filter((path) => path.familyId === definition.id);
    return {
      ...definition,
      label: familyLabel(definition.id),
      sampleCount: values.length,
      completionDays: getQuantiles(values),
      pathIds: familyPaths.map((path) => path.id),
    };
  });
}


function familyLabel(id: SimulationFamilyId): string {
  return id === 'shorter' ? 'rezultate mai scurte' : id === 'central' ? 'rezultate centrale' : 'rezultate mai târzii';
}


function makeHistogram(values: number[]): SimulationHistogramBin[] {
  const min = values.reduce((current, value) => Math.min(current, value), Number.POSITIVE_INFINITY);
  const max = values.reduce((current, value) => Math.max(current, value), Number.NEGATIVE_INFINITY);
  const binCount = Math.min(32, Math.max(8, Math.ceil(Math.sqrt(values.length))));
  const width = max === min ? 1 : (max - min) / binCount;
  const counts = Array.from({ length: binCount }, () => 0);
  for (const value of values) {
    const index = max === min ? Math.floor(binCount / 2) : Math.min(binCount - 1, Math.floor((value - min) / width));
    counts[index] += 1;
  }
  return counts.map((count, index) => ({
    fromDays: max === min ? min - 0.5 : min + index * width,
    toDays: max === min ? max + 0.5 : min + (index + 1) * width,
    count,
    share: count / values.length,
  }));
}

function getQuantiles(values: number[]): Quantiles {
  return getQuantilesFromSorted([...values].sort((a, b) => a - b));
}

function getQuantilesFromSorted(values: number[]): Quantiles {
  return { p10: percentile(values, 0.1), p50: percentile(values, 0.5), p80: percentile(values, 0.8), p90: percentile(values, 0.9) };
}

function percentile(sorted: number[], q: number): number {
  if (!sorted.length) return 0;
  const position = (sorted.length - 1) * q;
  const low = Math.floor(position);
  const high = Math.ceil(position);
  if (low === high) return sorted[low];
  return sorted[low] + (sorted[high] - sorted[low]) * (position - low);
}

function sampleTriangular(draw: number, min: number, mode: number, max: number): number {
  if (min === max) return min;
  const split = (mode - min) / (max - min);
  return draw < split
    ? min + Math.sqrt(draw * (max - min) * (mode - min))
    : max - Math.sqrt((1 - draw) * (max - min) * (max - mode));
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function isCompleted(record: ProjectRecord): boolean {
  if (record.completed_at) return true;
  const status = normalize(record.status || '');
  return ['done', 'complete', 'completed', 'finished', 'finalized', 'finalizata', 'terminat', 'terminata', 'livrat', 'incheiat', 'incheiata'].includes(status);
}

function ownerKey(record: ProjectRecord): string {
  return record.owner_id || normalize(record.owner || '');
}

function ownerLabel(record: ProjectRecord): string {
  return record.owner || record.title;
}

function normalize(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLocaleLowerCase();
}

function formatSigned(value: number): string {
  return `${value > 0 ? '+' : ''}${Number.isInteger(value) ? value : value.toFixed(1)}`;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  if (typeof DOMException !== 'undefined') throw new DOMException('Simularea a fost anulată.', 'AbortError');
  const error = new Error('Simularea a fost anulată.');
  error.name = 'AbortError';
  throw error;
}

function yieldToBrowser(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function structuredCloneSafe<T>(value: T): T {
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value)) as T;
}

function sourceRefFingerprint(refs: Array<{ source_id: string; location: string; quote: string }>): string[][] {
  return refs.map((ref) => [ref.source_id, ref.location, ref.quote]).sort((a, b) => a.join('\u0000').localeCompare(b.join('\u0000')));
}

async function hashText(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  if (globalThis.crypto?.subtle) {
    const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
    return `sha256:${[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
  }
  let hash = 0xcbf29ce484222325n;
  for (const byte of bytes) hash = BigInt.asUintN(64, (hash ^ BigInt(byte)) * 0x100000001b3n);
  return `fnv1a64:${hash.toString(16).padStart(16, '0')}`;
}
