import type { ProjectRecord } from './types';
import type { SourceRef } from './types';

export type DependencyNode = Pick<ProjectRecord, 'id' | 'kind' | 'depends_on'>;
export type DependencyOverrides = Readonly<Record<string, readonly string[]>>;

export class DependencyCycleError extends Error {
  constructor(readonly cycle: string[]) {
    super(`Graful dependențelor conține un ciclu: ${cycle.join(' → ')}.`);
    this.name = 'DependencyCycleError';
  }
}

/** Returns one deterministic cycle among task and deliverable prerequisite edges, if present. */
export function findTaskDependencyCycle(records: readonly DependencyNode[], overrides: DependencyOverrides = {}): string[] | null {
  const nodes = new Map(records.filter((record) => record.kind === 'task' || record.kind === 'deliverable').map((record) => [record.id, record]));
  const color = new Map<string, 0 | 1 | 2>();
  const path: string[] = [];

  const visit = (id: string): string[] | null => {
    color.set(id, 1);
    path.push(id);
    const dependencies = [...(overrides[id] ?? nodes.get(id)?.depends_on ?? [])].filter((dependencyId) => nodes.has(dependencyId)).sort();
    for (const dependencyId of dependencies) {
      const dependencyColor = color.get(dependencyId) || 0;
      if (dependencyColor === 1) return [...path.slice(path.indexOf(dependencyId)), dependencyId];
      if (dependencyColor === 0) {
        const cycle = visit(dependencyId);
        if (cycle) return cycle;
      }
    }
    path.pop();
    color.set(id, 2);
    return null;
  };

  for (const id of [...nodes.keys()].sort()) {
    if ((color.get(id) || 0) === 0) {
      const cycle = visit(id);
      if (cycle) return cycle;
    }
  }
  return null;
}

export function assertTaskDependencyAcyclic(records: readonly DependencyNode[], overrides: DependencyOverrides = {}): void {
  const cycle = findTaskDependencyCycle(records, overrides);
  if (cycle) throw new DependencyCycleError(cycle);
}

/** Replaces a claimed locator with the locator around an exact quote match in parsed source text. */
export function normalizeSourceRefLocation(sourceText: string, ref: SourceRef): SourceRef | null {
  if (!ref.quote.trim()) return null;
  const positions: number[] = [];
  let cursor = 0;
  while (positions.length < 101) {
    const position = sourceText.indexOf(ref.quote, cursor);
    if (position < 0) break;
    positions.push(position);
    cursor = position + Math.max(1, ref.quote.length);
  }
  if (!positions.length) return null;

  const claimed = locatorTokens(ref.location);
  const matchingPosition = claimed.length
    ? positions.find((position) => locatorTokens(locatorAt(sourceText, position)).join('|') === claimed.join('|'))
    : undefined;
  const position = matchingPosition ?? positions[0];
  return { ...ref, location: locatorAt(sourceText, position) };
}

function locatorAt(text: string, position: number): string {
  const lineStart = text.lastIndexOf('\n', Math.max(0, position - 1)) + 1;
  const lineEndIndex = text.indexOf('\n', position);
  const lineEnd = lineEndIndex < 0 ? text.length : lineEndIndex;
  const sourceLine = text.slice(lineStart, lineEnd);
  const anchorStart = sourceLine.indexOf('[');
  const anchorEnd = anchorStart < 0 ? -1 : sourceLine.indexOf(']:', anchorStart);
  const anchor = anchorStart >= 0 && anchorEnd > anchorStart ? sourceLine.slice(anchorStart + 1, anchorEnd) : '';
  const page = anchor.match(/\bpage\s+(\d+)\b/i)?.[1];
  const sheet = anchor.match(/\bsheet\s+([^,\]]+)/i)?.[1]?.trim();
  const row = anchor.match(/\brow\s+(\d+)\b/i)?.[1];
  const line = anchor.match(/\bline\s+(\d+)\b/i)?.[1];
  const parts = [page ? `page ${page}` : '', sheet ? `sheet ${sheet}` : '', row ? `row ${row}` : line ? `line ${line}` : ''].filter(Boolean);
  if (parts.length) return parts.join(', ');
  return `line ${text.slice(0, position).split('\n').length}`;
}

function locatorTokens(location: string): string[] {
  return [...location.toLocaleLowerCase().matchAll(/\b(page|sheet|row|line)\s+([^,\s]+)/g)]
    .map((match) => `${match[1]} ${match[2]}`)
    .sort();
}
