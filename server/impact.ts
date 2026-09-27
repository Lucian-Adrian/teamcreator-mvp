import type {
  ImpactPath,
  ProjectImpact,
  ProjectRecord,
  ProjectWorkspace,
  SourceRef,
} from '../shared/types.js';

const MAX_IMPACT_PATHS = 256;

function compareText(left: string, right: string) {
  return left.localeCompare(right, 'en', { sensitivity: 'base' }) || left.localeCompare(right);
}

function graphRecords(workspace: ProjectWorkspace) {
  const records = [...workspace.tasks, ...workspace.deliverables]
    .filter((record) => Boolean(record.id))
    .sort((left, right) => compareText(left.id, right.id) || compareText(left.title, right.title));
  const byId = new Map<string, ProjectRecord>();
  for (const record of records) {
    if (!byId.has(record.id)) byId.set(record.id, record);
  }

  const prerequisites = new Map<string, string[]>();
  for (const [id, record] of byId) {
    const ids = [...new Set((record.depends_on || []).map((value) => String(value).trim()).filter((value) => byId.has(value)))];
    prerequisites.set(id, ids.sort(compareText));
  }
  return { byId, prerequisites };
}

/** Return strongly connected components that contain a dependency cycle. */
export function findDependencyCycles(workspace: ProjectWorkspace): string[][] {
  const { byId, prerequisites } = graphRecords(workspace);
  let nextIndex = 0;
  const indexById = new Map<string, number>();
  const lowLinkById = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const cycles: string[][] = [];

  const visit = (id: string) => {
    const index = nextIndex++;
    indexById.set(id, index);
    lowLinkById.set(id, index);
    stack.push(id);
    onStack.add(id);

    for (const prerequisiteId of prerequisites.get(id) || []) {
      if (!indexById.has(prerequisiteId)) {
        visit(prerequisiteId);
        lowLinkById.set(id, Math.min(lowLinkById.get(id)!, lowLinkById.get(prerequisiteId)!));
      } else if (onStack.has(prerequisiteId)) {
        lowLinkById.set(id, Math.min(lowLinkById.get(id)!, indexById.get(prerequisiteId)!));
      }
    }

    if (lowLinkById.get(id) !== indexById.get(id)) return;
    const component: string[] = [];
    let current: string;
    do {
      current = stack.pop()!;
      onStack.delete(current);
      component.push(current);
    } while (current !== id);

    const selfCycle = component.length === 1 && (prerequisites.get(id) || []).includes(id);
    if (component.length > 1 || selfCycle) cycles.push(component.sort(compareText));
  };

  for (const id of [...byId.keys()].sort(compareText)) {
    if (!indexById.has(id)) visit(id);
  }

  return cycles.sort((left, right) => compareText(left[0] || '', right[0] || ''));
}

function uniqueSourceRefs(refs: SourceRef[]) {
  const unique = new Map<string, SourceRef>();
  for (const ref of refs) {
    if (!ref?.source_id || !ref.location || !ref.quote) continue;
    unique.set(`${ref.source_id}\u0000${ref.location}\u0000${ref.quote}`, ref);
  }
  return [...unique.values()].sort((left, right) =>
    compareText(left.source_id, right.source_id)
    || compareText(left.location, right.location)
    || compareText(left.quote, right.quote));
}

function dependencyRefs(dependent: ProjectRecord, prerequisiteId: string) {
  return dependent.dependency_refs?.[prerequisiteId] || [];
}

function pathForChain(chain: string[], byId: Map<string, ProjectRecord>): ImpactPath | undefined {
  const first = byId.get(chain[0]);
  const last = byId.get(chain[chain.length - 1]);
  if (!first || !last || chain.length < 2) return undefined;

  const via = chain.slice(1, -1).map((id) => ({
    id,
    title: byId.get(id)?.title || id,
    relation: 'depends_on' as const,
  }));
  const refs: SourceRef[] = [];
  for (let index = 1; index < chain.length; index += 1) {
    const dependent = byId.get(chain[index]);
    const prerequisiteId = chain[index - 1];
    if (dependent) refs.push(...dependencyRefs(dependent, prerequisiteId));
  }

  const labels = chain.map((id) => byId.get(id)?.title || id);
  return {
    from_id: first.id,
    from_title: first.title,
    affected_id: last.id,
    affected_title: last.title,
    via,
    basis: 'derived_by_rule',
    explanation: `Calculated dependency path: ${labels.join(' → ')}. Each next item depends on the item before it.`,
    source_refs: uniqueSourceRefs(refs),
  };
}

/** Trace tasks and deliverables that depend on the selected task. */
export function calculateImpact(workspace: ProjectWorkspace, taskId: string): ProjectImpact {
  const { byId, prerequisites } = graphRecords(workspace);
  const cycles = findDependencyCycles(workspace);
  const task = workspace.tasks.find((record) => record.id === taskId)
    || workspace.deliverables.find((record) => record.id === taskId);
  const graph = { cycles, has_cycles: cycles.length > 0 };

  if (!task) {
    return {
      task_id: taskId,
      task_title: taskId,
      paths: [],
      graph,
      warning: `Task ${taskId} is not present in this project workspace.`,
    };
  }
  const dependents = new Map<string, string[]>();
  for (const [dependentId, prerequisiteIds] of prerequisites) {
    for (const prerequisiteId of prerequisiteIds) {
      const current = dependents.get(prerequisiteId) || [];
      current.push(dependentId);
      dependents.set(prerequisiteId, current);
    }
  }
  for (const [id, ids] of dependents) {
    dependents.set(id, ids.sort((left, right) => {
      const leftTitle = byId.get(left)?.title || left;
      const rightTitle = byId.get(right)?.title || right;
      return compareText(leftTitle, rightTitle) || compareText(left, right);
    }));
  }

  const paths: ImpactPath[] = [];
  const queue: string[][] = [[task.id]];
  let truncated = false;
  const cyclicIds = new Set(cycles.flat());
  const cycleBoundaries = new Set<string>();
  if (cyclicIds.has(task.id)) cycleBoundaries.add(task.id);

  for (let cursor = 0; cursor < queue.length && !cyclicIds.has(task.id); cursor += 1) {
    const chain = queue[cursor];
    const currentId = chain[chain.length - 1];
    for (const dependentId of dependents.get(currentId) || []) {
      if (chain.includes(dependentId)) continue;
      const nextChain = [...chain, dependentId];
      const path = pathForChain(nextChain, byId);
      if (path && paths.length >= MAX_IMPACT_PATHS) {
        truncated = true;
        break;
      }
      if (path) paths.push(path);
      if (cyclicIds.has(dependentId)) {
        cycleBoundaries.add(dependentId);
        continue;
      }
      queue.push(nextChain);
    }
    if (truncated) break;
  }

  const unresolved = [...byId.values()]
    .filter((record) => (record.unresolved_dependencies || []).length > 0)
    .sort((left, right) => compareText(left.title, right.title))
    .map((record) => `${record.title}: ${(record.unresolved_dependencies || []).join(', ')}`);
  const cycleDescription = cycles.map((cycle) => cycle.map((id) => byId.get(id)?.title || id).join(' ↔ ')).join('; ');
  const boundaryTitles = [...cycleBoundaries].map((id) => byId.get(id)?.title || id).sort(compareText);
  const warnings = [
    ...(cycles.length ? [
      cyclicIds.has(task.id)
        ? `Starting task ${task.title} is part of a dependency cycle (${cycleDescription}); downstream traversal stopped here.`
        : boundaryTitles.length
          ? `Dependency cycles detected (${cycleDescription}). Traversal stopped at cycle ${boundaryTitles.length === 1 ? 'boundary' : 'boundaries'}: ${boundaryTitles.join(', ')}; paths into unaffected branches are still shown.`
          : `Dependency cycles detected (${cycleDescription}). No traversed path crossed those cycles.`
    ] : []),
    ...(truncated ? [`Showing the first ${MAX_IMPACT_PATHS} dependency paths; additional paths were omitted.`] : []),
    ...(unresolved.length ? ['Some dependency names could not be linked to project records, so impact coverage may be incomplete.'] : []),
  ];

  return {
    task_id: task.id,
    task_title: task.title,
    paths,
    graph,
    ...(warnings.length ? { warning: warnings.join(' ') } : {}),
  };
}
