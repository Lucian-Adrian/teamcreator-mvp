import type { SourceRef } from '../../shared/types';

export interface ProjectNavigation {
  projectId: string;
  page: 'context' | 'map' | 'simulation' | 'diagnostic';
  contextPanel: 'sources' | 'review' | 'history';
  team: { group: 'team' | 'tasks'; taskView: 'list' | 'gantt' | 'kanban' | 'burndown' | 'priorities'; memberId?: string; taskId?: string };
  decisionTab: 'pending' | 'applied' | 'reports';
  selectedNode: { kind: 'member' | 'task' | 'deliverable'; id: string } | null;
  sourceId: string;
  sourceRef: SourceRef | null;
  decisionId: string;
  overlay: 'create' | 'ingest' | null;
  manualOpen: boolean;
  manualKind: 'member' | 'task';
}

export const emptyNavigation: ProjectNavigation = {
  projectId: '', page: 'context', contextPanel: 'sources',
  team: { group: 'team', taskView: 'list' }, decisionTab: 'pending',
  selectedNode: null, sourceId: '', sourceRef: null, decisionId: '',
  overlay: null, manualOpen: false, manualKind: 'task',
};

export function readNavigation(): ProjectNavigation {
  if (typeof window === 'undefined') return structuredClone(emptyNavigation);
  const hash = window.location.hash.replace(/^#\/?/, '');
  const [route, query = ''] = hash.split('?');
  const [page, section, view] = route.split('/');
  const params = new URLSearchParams(query);
  const next = structuredClone(emptyNavigation);
  if (['context', 'map', 'simulation', 'diagnostic'].includes(page)) next.page = page as ProjectNavigation['page'];
  next.projectId = params.get('project') || '';
  if (next.page === 'context' && ['review', 'history'].includes(section)) next.contextPanel = section as 'review' | 'history';
  if (next.page === 'map') {
    next.team.group = section === 'tasks' ? 'tasks' : 'team';
    if (['list', 'gantt', 'kanban', 'burndown', 'priorities'].includes(view)) next.team.taskView = view as ProjectNavigation['team']['taskView'];
    if (params.get('member')) next.team.memberId = params.get('member')!;
    if (params.get('task')) next.team.taskId = params.get('task')!;
  }
  if (next.page === 'diagnostic' && ['pending', 'applied', 'reports'].includes(section)) next.decisionTab = section as ProjectNavigation['decisionTab'];
  next.sourceId = params.get('source') || '';
  next.decisionId = params.get('decision') || '';
  return next;
}

export function navigationHash(state: ProjectNavigation): string {
  const path = state.page === 'map' ? `map/${state.team.group}${state.team.group === 'tasks' ? `/${state.team.taskView}` : ''}`
    : state.page === 'context' ? `context${state.contextPanel === 'sources' ? '' : `/${state.contextPanel}`}`
      : state.page === 'diagnostic' ? `diagnostic/${state.decisionTab}` : state.page;
  const query = new URLSearchParams();
  if (state.projectId) query.set('project', state.projectId);
  if (state.page === 'map' && state.team.memberId) query.set('member', state.team.memberId);
  if (state.page === 'map' && state.team.taskId) query.set('task', state.team.taskId);
  if (state.page === 'context' && state.sourceId) query.set('source', state.sourceId);
  if (state.page === 'diagnostic' && state.decisionId) query.set('decision', state.decisionId);
  return `#${path}${query.size ? `?${query}` : ''}`;
}
