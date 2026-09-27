import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Background, BackgroundVariant, Controls, Handle, MarkerType, Panel, Position, ReactFlow, useNodesInitialized, useNodesState, useReactFlow, useUpdateNodeInternals, type Edge, type Node, type NodeProps, type ReactFlowInstance } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { Focus, Maximize2, Network, RotateCcw, Search, X } from 'lucide-react';
import type { ProjectRecord, ProjectWorkspace, SourceRef } from '../../shared/types';
import { getMemberAvatar } from './member-avatar';
import './team-people-map.css';

type Props = {
  workspace: ProjectWorkspace;
  selectedMemberId: string | null;
  onSelectMember: (id: string) => void;
  onSelectRelation?: (id: string) => void;
};

type FlowKind = 'handoff' | 'review' | 'approval' | 'unknown';
type MemberFlow = {
  key: string;
  fromId: string;
  toId: string;
  kind: FlowKind;
  tasks: string[];
  sources: SourceRef[];
};

const flowLabels: Record<FlowKind, string> = {
  handoff: 'Predare',
  review: 'Revizuire',
  approval: 'Aprobare',
  unknown: 'Dependență',
};

type PersonNode = Node<{ member: ProjectRecord; synthetic: boolean; taskCount: number }, 'person'>;
function PersonCanvasNode({ id, data }: NodeProps<PersonNode>) {
  const updateNodeInternals = useUpdateNodeInternals();
  useEffect(() => {
    const frame = requestAnimationFrame(() => updateNodeInternals(id));
    return () => cancelAnimationFrame(frame);
  }, [id, updateNodeInternals]);
  const avatar = getMemberAvatar(data.member, data.synthetic);
  return <div className="tpm-person">
    <span className={`tpm-avatar${avatar ? ' tpm-avatar-image' : ''}`} aria-hidden="true" style={avatar?.style}>{avatar ? null : data.member.title.split(/\s+/).map(part => part[0]).slice(0, 2).join('')}</span>
    <div className="tpm-person-copy"><strong>{data.member.title}</strong><small title={data.member.role || ''}>{data.member.role || 'Rol neînregistrat'}</small><em>{data.taskCount ? `${data.taskCount} ${data.taskCount === 1 ? 'sarcină' : 'sarcini'}` : 'Fără sarcini'}</em></div>
    {(['left', 'right', 'top', 'bottom'] as const).flatMap(side => (['source', 'target'] as const).map(type => <Handle key={`${type}-${side}`} type={type} id={`${type}-${side}`} position={({ left: Position.Left, right: Position.Right, top: Position.Top, bottom: Position.Bottom })[side]} isConnectable={false} />))}
  </div>;
}
const nodeTypes = { person: PersonCanvasNode };
const seedPositions = [{ x: 265, y: 155 }, { x: 0, y: 55 }, { x: 530, y: 45 }, { x: 520, y: 290 }, { x: 260, y: 0 }, { x: 520, y: 445 }, { x: 0, y: 295 }, { x: 0, y: 455 }, { x: 260, y: 445 }, { x: 270, y: 300 }];
const seedPosition = (index: number, compact: boolean) => compact
  ? { x: index % 2 ? 182 : 0, y: Math.floor(index / 2) * 114 + (index % 2 ? 26 : 0) }
  : seedPositions[index] || { x: (index % 3) * 265, y: 600 + Math.floor((index - 10) / 3) * 145 };
type CanvasState = { positions?: Record<string, { x: number; y: number }> };
function readCanvas(projectId: string): CanvasState {
  try { return JSON.parse(localStorage.getItem(`tc-team-canvas-v2:${projectId}`) || '{}'); } catch { return {}; }
}
function writeCanvas(projectId: string, patch: CanvasState) {
  try { localStorage.setItem(`tc-team-canvas-v2:${projectId}`, JSON.stringify({ ...readCanvas(projectId), ...patch })); } catch { /* Layout can remain session-only when browser storage is full. */ }
}

function useMedia(query: string) {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => { const media = window.matchMedia(query); const changed = () => setMatches(media.matches); media.addEventListener('change', changed); return () => media.removeEventListener('change', changed); }, [query]);
  return matches;
}
const canvasPadding = (compact: boolean) => ({ top: '58px', right: compact ? '18px' : '36px', bottom: '38px', left: compact ? '30px' : '36px' } as const);

function CanvasFraming({ compact, container }: { compact: boolean; container: React.RefObject<HTMLDivElement> }) {
  const ready = useNodesInitialized();
  const { fitView } = useReactFlow();
  useEffect(() => {
    if (!ready || !container.current) return;
    let frame = 0;
    const frameContent = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(() => { frame = requestAnimationFrame(() => void fitView({ padding: canvasPadding(compact), maxZoom: 1 })); }); };
    const observer = new ResizeObserver(frameContent);
    observer.observe(container.current);
    frameContent();
    return () => { observer.disconnect(); cancelAnimationFrame(frame); };
  }, [ready, compact, container, fitView]);
  return null;
}

function normalized(value: unknown) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLocaleLowerCase();
}

function flowKind(prerequisite: ProjectRecord, dependent: ProjectRecord): FlowKind {
  const titles = `${prerequisite.title} ${dependent.title}`;
  if (/approv|aprob/i.test(titles)) return 'approval';
  if (/review|revizu|verif|validat|inspect/i.test(titles)) return 'review';
  if (/pred[aă]|handoff|transmit|livreaz|trimite|expedi/i.test(titles)) return 'handoff';
  return 'unknown';
}

export default function TeamPeopleMap({ workspace, selectedMemberId, onSelectMember, onSelectRelation }: Props) {
  const [nodes, setNodes, onNodesChange] = useNodesState<PersonNode>([]);
  const canvasRef = useRef<HTMLDivElement>(null);
  const flowInstance = useRef<ReactFlowInstance<PersonNode, Edge> | null>(null);
  const compact = useMedia('(max-width: 600px)');
  const reducedMotion = useMedia('(prefers-reduced-motion: reduce)');
  const canvasKey = `${workspace.project.id}:${compact ? 'compact' : 'wide'}`;
  const lastProject = useRef(canvasKey);
  const [showAll, setShowAll] = useState(true);
  const [query, setQuery] = useState('');
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const members = workspace.members.filter((member) => member.title?.trim());
  const memberById = new Map(members.map((member) => [member.id, member]));
  const aliases = new Map<string, string>();
  for (const member of members) {
    aliases.set(normalized(member.id), member.id);
    aliases.set(normalized(member.title), member.id);
  }
  const assignments = new Map(workspace.assignments.map((assignment) => [assignment.record_id, assignment.member_id]));
  const records = [...workspace.tasks, ...workspace.deliverables];
  const recordsById = new Map(records.map((record) => [record.id, record]));
  const memberFor = (record: ProjectRecord) => {
    const assignedId = record.owner_id || assignments.get(record.id);
    if (assignedId && memberById.has(assignedId)) return assignedId;
    const owner = normalized(record.owner);
    return owner ? aliases.get(owner) || null : null;
  };

  const { flows, unresolvedCount } = useMemo(() => {
    const dependencies = new Map<string, { dependent: ProjectRecord; prerequisite: ProjectRecord; refs: SourceRef[] }>();
    const refsByPair = new Map<string, SourceRef[]>();
    for (const dependency of workspace.dependencies) {
      const dependent = recordsById.get(dependency.from_id);
      const prerequisite = recordsById.get(dependency.to_id);
      if (!dependent || !prerequisite) continue;
      const key = `${dependent.id}\u0000${prerequisite.id}`;
      dependencies.set(key, { dependent, prerequisite, refs: dependency.source_refs || [] });
      refsByPair.set(key, dependency.source_refs || []);
    }
    for (const dependent of records) {
      for (const prerequisiteId of dependent.depends_on || []) {
        const prerequisite = recordsById.get(prerequisiteId);
        if (!prerequisite) continue;
        const key = `${dependent.id}\u0000${prerequisite.id}`;
        if (!dependencies.has(key)) dependencies.set(key, {
          dependent,
          prerequisite,
          refs: dependent.dependency_refs?.[prerequisite.id] || [],
        });
      }
    }

    const grouped = new Map<string, { fromId: string; toId: string; kind: FlowKind; tasks: Map<string, string>; sources: Map<string, SourceRef> }>();
    let unresolved = 0;
    for (const [key, dependency] of dependencies) {
      const fromId = memberFor(dependency.prerequisite);
      const toId = memberFor(dependency.dependent);
      if (!fromId || !toId) { unresolved += 1; continue; }
      if (fromId === toId) continue;
      const kind = flowKind(dependency.prerequisite, dependency.dependent);
      const flowKey = `${fromId}\u0000${toId}\u0000${kind}`;
      const flow = grouped.get(flowKey) || {
        fromId,
        toId,
        kind,
        tasks: new Map<string, string>(),
        sources: new Map<string, SourceRef>(),
      };
      flow.tasks.set(dependency.dependent.id, dependency.dependent.title);
      const refs = dependency.refs.length ? dependency.refs : refsByPair.get(key) || [];
      for (const ref of refs) flow.sources.set(`${ref.source_id}\u0000${ref.location || ''}\u0000${ref.quote || ''}`, ref);
      grouped.set(flowKey, flow);
    }
    const result: MemberFlow[] = [...grouped.entries()].map(([key, flow]) => ({
      key,
      fromId: flow.fromId,
      toId: flow.toId,
      kind: flow.kind,
      tasks: [...flow.tasks.values()],
      sources: [...flow.sources.values()],
    }));
    return { flows: result, unresolvedCount: unresolved };
  }, [workspace, records, recordsById, memberFor]);

  const focusId = members.some(member => member.id === selectedMemberId) ? selectedMemberId : members[0]?.id || null;
  useEffect(() => {
    const projectChanged = lastProject.current !== canvasKey;
    lastProject.current = canvasKey;
    const saved = readCanvas(canvasKey);
    setNodes(previous => members.map((member, index) => {
      const existing = projectChanged ? undefined : previous.find(node => node.id === member.id);
      const position = saved.positions?.[member.id];
      const savedPosition = position && Number.isFinite(position.x) && Number.isFinite(position.y) && Math.abs(position.x) < 50000 && Math.abs(position.y) < 50000 ? position : undefined;
      return { ...(existing || {}), id: member.id, type: 'person' as const, position: existing?.position || savedPosition || seedPosition(index, compact), data: { member, synthetic: Boolean(workspace.project.synthetic), taskCount: workspace.tasks.filter(task => memberFor(task) === member.id).length }, ariaLabel: `${member.title}, ${member.role || 'Membru'}`, deletable: false };
    }));
  }, [canvasKey, workspace.members, workspace.tasks, workspace.assignments]);
  const relatedIds = (id: string | null) => new Set([id, ...flows.filter(flow => flow.fromId === id || flow.toId === id).flatMap(flow => [flow.fromId, flow.toId])]);
  const focusedIds = relatedIds(focusId);
  const emphasizedIds = relatedIds(hoveredId || focusId);
  const displayNodes = nodes.map(node => ({ ...node, selected: node.id === focusId, hidden: !showAll && !focusedIds.has(node.id), className: emphasizedIds.has(node.id) ? 'tpm-related' : 'tpm-muted' }));
  const nodePositions = new Map(nodes.map(node => [node.id, node.position]));
  const edges: Edge[] = flows.filter(flow => showAll || flow.fromId === focusId || flow.toId === focusId).map(flow => {
    const from = nodePositions.get(flow.fromId) || { x: 0, y: 0 }; const to = nodePositions.get(flow.toId) || { x: 0, y: 0 };
    const vertical = Math.abs(to.x - from.x) < 100;
    const columnObstructed = vertical && nodes.some(node => node.id !== flow.fromId && node.id !== flow.toId && Math.abs(node.position.x - from.x) < 100 && node.position.y > Math.min(from.y, to.y) && node.position.y < Math.max(from.y, to.y));
    const sourceSide = columnObstructed ? 'left' : vertical ? to.y >= from.y ? 'bottom' : 'top' : to.x >= from.x ? 'right' : 'left';
    const targetSide = columnObstructed ? sourceSide : ({ left: 'right', right: 'left', top: 'bottom', bottom: 'top' })[sourceSide];
    const focused = flow.fromId === (hoveredId || focusId) || flow.toId === (hoveredId || focusId);
    const color = focused ? ({ handoff: '#209a82', review: '#3976d5', approval: '#8270c7', unknown: '#7890ab' })[flow.kind] : '#cfdae5';
    return { id: `${flow.fromId}-${flow.toId}-${flow.kind}`, source: flow.fromId, target: flow.toId, sourceHandle: `source-${sourceSide}`, targetHandle: `target-${targetSide}`, type: 'smoothstep', pathOptions: { borderRadius: 24, offset: 24 }, data: { flow },
      zIndex: focused ? 1 : 0, label: focused && !compact ? flowLabels[flow.kind] : undefined, labelStyle: { fill: color, fontSize: 11, fontWeight: 500 }, labelBgStyle: { fill: '#fff', fillOpacity: .97 }, labelBgPadding: [7, 4], labelBgBorderRadius: 6,
      style: { stroke: color, strokeWidth: focused ? 1.8 : 1.2, strokeDasharray: flow.kind === 'unknown' ? '4 5' : undefined }, markerEnd: { type: MarkerType.ArrowClosed, color, width: 12, height: 12 }, interactionWidth: 20, focusable: true, ariaLabel: `${memberById.get(flow.fromId)?.title} către ${memberById.get(flow.toId)?.title}: ${flowLabels[flow.kind]}`, deletable: false };
  });
  const openRelation = (edge: Edge) => {
    const flow = edge.data?.flow as MemberFlow | undefined;
    if (flow) onSelectRelation?.(flow.fromId === focusId ? flow.toId : flow.fromId);
  };
  const fit = (ids?: Set<string | null>) => void flowInstance.current?.fitView({ nodes: ids ? nodes.filter(node => ids.has(node.id)) : undefined, padding: canvasPadding(compact), maxZoom: compact ? 1 : 1.1, duration: reducedMotion ? 0 : 240 });
  useEffect(() => {
    if (showAll) return;
    const frame = requestAnimationFrame(() => fit(focusedIds));
    return () => cancelAnimationFrame(frame);
  }, [focusId, showAll]);
  const toggleRelations = () => { setShowAll(value => !value); requestAnimationFrame(() => fit(showAll ? focusedIds : new Set(nodes.map(node => node.id)))); };
  const selectSearchResult = (id: string) => { onSelectMember(id); setQuery(''); setShowAll(false); requestAnimationFrame(() => fit(relatedIds(id))); };
  const reset = () => {
    setNodes(current => current.map((node, index) => ({ ...node, position: seedPosition(index, compact) })));
    setShowAll(true);
    writeCanvas(canvasKey, { positions: {} });
    requestAnimationFrame(() => fit(new Set(nodes.map(node => node.id))));
  };
  if (!members.length) return <section className="team-people-map team-people-map-empty"><strong>Nu există persoane înregistrate.</strong><p>Adaugă membrii pentru a construi harta.</p></section>;

  return <section className="team-people-map" aria-label="Harta relațiilor dintre membrii echipei">
    <div className="tpm-toolbar"><span><Network size={15} />{members.length} persoane <i /> {flows.length} relații</span><button type="button" aria-pressed={!showAll} onClick={toggleRelations}><Focus size={14} />{showAll ? 'Relațiile persoanei' : 'Toate relațiile'}</button></div>
    <div ref={canvasRef} className="tpm-canvas" aria-label="Canvas cu oameni conectați">
      <ReactFlow<PersonNode, Edge> key={canvasKey} nodes={displayNodes} edges={edges} nodeTypes={nodeTypes} onNodesChange={changes => { onNodesChange(changes); const selection = changes.find(change => change.type === 'select' && change.selected); if (selection?.type === 'select' && selection.id !== focusId) onSelectMember(selection.id); }}
        onNodeClick={(_, node) => onSelectMember(node.id)} onEdgeClick={(_, edge) => openRelation(edge)}
        onNodeMouseEnter={(_, node) => setHoveredId(node.id)} onNodeMouseLeave={() => setHoveredId(null)}
        onEdgesChange={changes => { const selection = changes.find(change => change.type === 'select' && change.selected); if (selection?.type === 'select') { const edge = edges.find(item => item.id === selection.id); if (edge) openRelation(edge); } }}
        onNodeDragStop={(_, __, draggedNodes) => { const current = flowInstance.current?.getNodes() || draggedNodes; writeCanvas(canvasKey, { positions: Object.fromEntries(current.map(node => [node.id, node.position])) }); }}
        onInit={instance => { flowInstance.current = instance; }}
        fitView fitViewOptions={{ padding: canvasPadding(compact), maxZoom: 1 }} minZoom={.2} maxZoom={2} nodesConnectable={false} nodesDraggable={!compact} edgesReconnectable={false} deleteKeyCode={null} nodeDragThreshold={4} panOnDrag={!compact} zoomOnScroll={!compact} zoomOnPinch zoomOnDoubleClick={false} preventScrolling={false} attributionPosition="bottom-right">
        <CanvasFraming compact={compact} container={canvasRef} />
        <Background variant={BackgroundVariant.Dots} gap={22} size={1} color="#dce5ed" />
        <Controls showInteractive={false} showFitView={false} aria-label="Zoom" />
        <Panel position="top-left" className="tpm-search-panel"><label className="tpm-search"><Search size={14} /><input aria-label="Caută o persoană" placeholder="Caută o persoană" value={query} onChange={event => setQuery(event.target.value)} onKeyDown={event => { if (event.key === 'Escape') setQuery(''); if (event.key === 'Enter') { const match = members.find(member => normalized(member.title).includes(normalized(query))); if (query && match) selectSearchResult(match.id); } }} />{query && <button type="button" aria-label="Șterge căutarea" onClick={() => setQuery('')}><X size={13} /></button>}</label>{query && <div className="tpm-search-results">{members.filter(member => normalized(`${member.title} ${member.role}`).includes(normalized(query))).map(member => <button type="button" key={member.id} onClick={() => selectSearchResult(member.id)}>{member.title}<small>{member.role}</small></button>)}{!members.some(member => normalized(`${member.title} ${member.role}`).includes(normalized(query))) && <span>Nicio persoană găsită.</span>}</div>}</Panel>
        <Panel position="top-right" className="tpm-view-actions"><button type="button" aria-label="Încadrează harta" title="Încadrează harta" onClick={() => fit()}><Maximize2 size={15} /></button><button type="button" aria-label="Reașază persoanele" title="Reașază persoanele" onClick={reset}><RotateCcw size={15} /></button></Panel>
        <Panel position="bottom-center"><span className="tpm-canvas-hint">{compact ? 'Atinge o persoană pentru detalii' : 'Mută persoanele · selectează o legătură'}</span></Panel>
      </ReactFlow>
    </div>
    <footer className="tpm-foot"><span className="tpm-legend"><i />Predare<i />Revizuire<i />Aprobare</span><span>{unresolvedCount ? `${unresolvedCount} dependențe cu responsabil de clarificat` : 'Relații din sarcinile proiectului'}</span></footer>
  </section>;
}
