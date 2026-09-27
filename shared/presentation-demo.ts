import type { ProjectSummary, ProjectWorkspace } from './types';
import {
  createDefaultSimulationConfig,
  type SimulationConfig,
  type SharedRiskFactor,
  type TriangularEstimate,
} from './simulation';

export const PRESENTATION_DEMO_VERSION = '2026-09-27.3';
export const PRESENTATION_DEMO_NAME = 'Iluminat stradal · Bălți · prezentare';
export const PRESENTATION_DEMO_DESCRIPTION = `Demonstrație completă · date, roluri și relații fictive · versiunea ${PRESENTATION_DEMO_VERSION}.`;

type PresentationDemoIdentity = Pick<ProjectSummary, 'name' | 'synthetic' | 'description'>;

/** Exact, versioned match. Cloned project IDs do not affect recognition. */
export function isPresentationDemo(workspaceOrProject: ProjectWorkspace | PresentationDemoIdentity | null | undefined): boolean {
  if (!workspaceOrProject) return false;
  const project = 'project' in workspaceOrProject ? workspaceOrProject.project : workspaceOrProject;
  return project.synthetic === true
    && project.name === PRESENTATION_DEMO_NAME
    && typeof project.description === 'string'
    && project.description.includes(PRESENTATION_DEMO_VERSION);
}

const durationPreset: Record<string, Omit<TriangularEstimate, 'basis' | 'confirmed' | 'rationale'>> = {
  'Pregătește planul tehnic intermediar': { min: 2, mode: 3, max: 5 },
  'Revizie tehnică a planului intermediar': { min: 1, mode: 2, max: 4 },
  'Obține aprobarea beneficiarului': { min: 1, mode: 2, max: 4 },
  'Confirmă data livrării cu furnizorul': { min: 1, mode: 2, max: 5 },
  'Pregătește dosarul de achiziție': { min: 1, mode: 2, max: 4 },
  'Revizuiește data furnizorului la următorul check-in': { min: 0.5, mode: 1, max: 2 },
  'Verifică lista de materiale': { min: 1, mode: 2, max: 3 },
  'Compară ofertele tehnice': { min: 1, mode: 2, max: 4 },
  'Decide suplimentarea capacității': { min: 0.5, mode: 1, max: 2 },
  'Pregătește planul de instalare': { min: 2, mode: 3, max: 5 },
  'Revizuiește planul de siguranță': { min: 1, mode: 1.5, max: 3 },
  'Pregătește raportul pentru client': { min: 0.5, mode: 1, max: 2 },
  'Confirmă fereastra de instalare': { min: 1, mode: 2, max: 4 },
  'Verifică accesul pentru montaj': { min: 1, mode: 2, max: 4 },
  'Verifică instalația după montaj': { min: 1, mode: 2, max: 4 },
};

const capacityByMemberName: Record<string, { availabilityFraction: number; maxConcurrentTasks: number }> = {
  'Elena Rusu': { availabilityFraction: 0.6, maxConcurrentTasks: 1 },
  'Victor Munteanu': { availabilityFraction: 0.8, maxConcurrentTasks: 1 },
  'Irina Ceban': { availabilityFraction: 0.4, maxConcurrentTasks: 1 },
  'Mihai Lungu': { availabilityFraction: 0.6, maxConcurrentTasks: 1 },
  'Sofia Dinu': { availabilityFraction: 0.4, maxConcurrentTasks: 1 },
  'Andrei Rotaru': { availabilityFraction: 0.6, maxConcurrentTasks: 1 },
  'Dana Moraru': { availabilityFraction: 0.4, maxConcurrentTasks: 1 },
  'Radu Ionescu': { availabilityFraction: 0.6, maxConcurrentTasks: 1 },
  'Ioana Popa': { availabilityFraction: 0.4, maxConcurrentTasks: 1 },
  'Oleg Balan': { availabilityFraction: 0.6, maxConcurrentTasks: 1 },
};

const demoRiskPresets: Array<Omit<SharedRiskFactor, 'taskIds'> & { taskTitles: string[] }> = [
  {
    id: 'risk-vendor-confirmation',
    label: 'Confirmarea livrării furnizorului',
    taskTitles: ['Confirmă data livrării cu furnizorul', 'Pregătește dosarul de achiziție', 'Revizuiește data furnizorului la următorul check-in', 'Compară ofertele tehnice', 'Confirmă fereastra de instalare'],
    probability: 0.34,
    durationMultiplier: { min: 1.05, mode: 1.3, max: 1.8 },
    rationale: 'Parametru introdus manual pentru scenariul sintetic, pornind de la riscul R-01; rata nu este observată și rămâne editabilă.',
  },
  {
    id: 'risk-approval-window',
    label: 'Așteptare pentru aprobarea beneficiarului',
    taskTitles: ['Revizie tehnică a planului intermediar', 'Obține aprobarea beneficiarului', 'Decide suplimentarea capacității', 'Pregătește raportul pentru client'],
    probability: 0.2,
    durationMultiplier: { min: 1.05, mode: 1.25, max: 1.6 },
    rationale: 'Ipoteză de variație pentru R-02; calendarul beneficiarului nu este consemnat și nu este estimat automat.',
  },
  {
    id: 'risk-site-access',
    label: 'Acces la teren pentru montaj',
    taskTitles: ['Pregătește planul de instalare', 'Revizuiește planul de siguranță', 'Confirmă fereastra de instalare', 'Verifică accesul pentru montaj', 'Verifică instalația după montaj'],
    probability: 0.17,
    durationMultiplier: { min: 1.05, mode: 1.3, max: 1.7 },
    rationale: 'Ipoteză editabilă legată de R-03; fereastra de acces nu este confirmată și nu este o frecvență istorică.',
  },
];

/**
 * Explicit hand-entered assumptions for the synthetic project. Values are neither
 * extracted automatically nor calibrated from historical customer outcomes.
 */
export function createPresentationSimulationConfig(workspace: ProjectWorkspace): SimulationConfig {
  if (!isPresentationDemo(workspace)) throw new Error('Presetul de prezentare este disponibil numai pentru proiectul demonstrativ versiunea curentă.');

  const config = createDefaultSimulationConfig(workspace);
  const estimates = { ...config.estimates };
  const taskMatchesByTitle = new Map<string, string[]>();
  for (const task of workspace.tasks) taskMatchesByTitle.set(task.title, [...(taskMatchesByTitle.get(task.title) || []), task.id]);
  const taskIdByTitle = new Map([...taskMatchesByTitle].map(([title, ids]) => [title, ids.length === 1 ? ids[0] : null]));
  for (const task of workspace.tasks) {
    if (task.completed_at || ['complete', 'completed', 'done', 'finalizat', 'finalizată', 'livrat'].includes((task.status || '').trim().toLocaleLowerCase('ro-RO'))) continue;
    const range = taskIdByTitle.get(task.title) ? durationPreset[task.title] : undefined;
    if (!range) continue;
    estimates[task.id] = {
      ...range,
      basis: 'placeholder',
      confirmed: false,
      rationale: 'Ipoteză manuală, editabilă, pentru prezentarea sintetică; nu este o durată observată sau confirmată de un client.',
    };
  }

  const memberCapacity = { ...config.memberCapacity };
  const memberMatchesByTitle = new Map<string, string[]>();
  for (const member of workspace.members) memberMatchesByTitle.set(member.title, [...(memberMatchesByTitle.get(member.title) || []), member.id]);
  for (const member of workspace.members) {
    if (memberMatchesByTitle.get(member.title)?.length !== 1) continue;
    const preset = capacityByMemberName[member.title];
    if (!preset) continue;
    memberCapacity[member.id] = {
      ...preset,
      confirmed: false,
      availabilityNote: 'Ipoteză manuală, editabilă, a presetului de demonstrație; nu este convertită din nota de disponibilitate.',
    };
  }

  const commonRisks = demoRiskPresets.flatMap(({ taskTitles, ...risk }) => {
    const taskIds = taskTitles.map((title) => taskIdByTitle.get(title)).filter((id): id is string => Boolean(id));
    return taskIds.length ? [{ ...risk, taskIds }] : [];
  });

  return {
    ...config,
    iterations: 10_000,
    seed: 20260927,
    calendar: { startDate: '2026-09-28', workingWeekdays: [1, 2, 3, 4, 5], holidays: [], deadlineDate: '2026-10-30' },
    estimates,
    commonRisks,
    memberCapacity,
  };
}
