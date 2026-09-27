import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Background, BackgroundVariant, Controls, Handle, MarkerType, Panel, Position, ReactFlow, useNodesState, useUpdateNodeInternals, type Edge, type Node, type NodeProps, type ReactFlowInstance, type Viewport } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
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
    <div className="tpm-portrait-anchor"><span className={`tpm-avatar${avatar ? ' tpm-avatar-image' : ''}`} aria-hidden="true" style={avatar?.style}>{avatar ? null : data.member.title.split(/\s+/).map(part => part[0]).slice(0, 2).join('')}</span>
      {(['left', 'right'] as const).flatMap(side => (['source', 'target'] as const).map(type => <Handle key={`${type}-${side}`} type={type} id={`${type}-${side}`} position={side === 'left' ? Position.Left : Position.Right} isConnectable={false} />))}
    </div>
    <strong>{data.member.title}</strong><small title={data.member.role || ''}>{data.member.role || 'Rol neînregistrat'}</small><em>{data.taskCount ? `${data.taskCount} ${data.taskCount === 1 ? 'sarcină' : 'sarcini'}` : 'Fără sarcini'}</em>
  </div>;
}
const nodeTypes = { person: PersonCanvasNode };
const seedPositions = [{ x: 430, y: 40 }, { x: 225, y: 195 }, { x: 465, y: 265 }, { x: 730, y: 55 }, { x: 120, y: 45 }, { x: 735, y: 430 }, { x: 125, y: 445 }, { x: 440, y: 470 }, { x: 20, y: 270 }, { x: 890, y: 270 }];
const seedPosition = (index: number) => seedPositions[index] || { x: (index % 4) * 250, y: 640 + Math.floor((index - 10) / 4) * 150 };
type CanvasState = { positions?: Record<string, { x: number; y: number }>; viewport?: Viewport };
function readCanvas(projectId: string): CanvasState {
  try { return JSON.parse(localStorage.getItem(`tc-team-canvas-v1:${projectId}`) || '{}'); } catch { return {}; }
}
function writeCanvas(projectId: string, patch: CanvasState) {
  try { localStorage.setItem(`tc-team-canvas-v1:${projectId}`, JSON.stringify({ ...readCanvas(projectId), ...patch })); } catch { /* Layout can remain session-only when browser storage is full. */ }
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
  const flowInstance = useRef<ReactFlowInstance<PersonNode, Edge> | null>(null);
  const lastProject = useRef(workspace.project.id);
  const [showAll, setShowAll] = useState(true);
  const initialViewport = useMemo(() => {
    const saved = readCanvas(workspace.project.id).viewport;
    return saved && Number.isFinite(saved.x) && Number.isFinite(saved.y) && saved.zoom >= .2 && saved.zoom <= 2 ? saved : undefined;
  }, [workspace.project.id]);
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
    const projectChanged = lastProject.current !== workspace.project.id;
    lastProject.current = workspace.project.id;
    const saved = readCanvas(workspace.project.id);
    setNodes(previous => members.map((member, index) => {
      const existing = projectChanged ? undefined : previous.find(node => node.id === member.id);
      const position = saved.positions?.[member.id];
      const savedPosition = position && Number.isFinite(position.x) && Number.isFinite(position.y) && Math.abs(position.x) < 50000 && Math.abs(position.y) < 50000 ? position : undefined;
      return { ...(existing || {}), id: member.id, type: 'person' as const, position: existing?.position || savedPosition || seedPosition(index), data: { member, synthetic: Boolean(workspace.project.synthetic), taskCount: workspace.tasks.filter(task => memberFor(task) === member.id).length }, ariaLabel: `${member.title}, ${member.role || 'Membru'}`, deletable: false };
    }));
  }, [workspace.project.id, workspace.members, workspace.tasks, workspace.assignments]);
  const displayNodes = nodes.map(node => ({ ...node, selected: node.id === focusId }));
  const nodePositions = new Map(nodes.map(node => [node.id, node.position]));
  const edges: Edge[] = flows.filter(flow => showAll || flow.fromId === focusId || flow.toId === focusId).map(flow => {
    const from = nodePositions.get(flow.fromId) || { x: 0, y: 0 }; const to = nodePositions.get(flow.toId) || { x: 0, y: 0 };
    const closeColumns = Math.abs(to.x - from.x) < 120;
    const sourceSide = to.x >= from.x ? 'right' : 'left';
    const targetSide = closeColumns ? sourceSide : sourceSide === 'right' ? 'left' : 'right';
    const focused = flow.fromId === focusId || flow.toId === focusId;
    return { id: `${flow.fromId}-${flow.toId}-${flow.kind}`, source: flow.fromId, target: flow.toId, sourceHandle: `source-${sourceSide}`, targetHandle: `target-${targetSide}`, type: 'default', data: { flow },
      label: focused ? flowLabels[flow.kind] : undefined, labelStyle: { fill: '#355a88', fontSize: 11, fontWeight: 500 }, labelBgStyle: { fill: '#fff', fillOpacity: .97 }, labelBgPadding: [6, 3], labelBgBorderRadius: 4,
      style: { stroke: focused ? '#3779db' : '#b7c4d5', strokeWidth: focused ? 1.6 : 1.1, strokeDasharray: flow.kind === 'unknown' ? '4 4' : undefined }, markerEnd: { type: MarkerType.ArrowClosed, color: focused ? '#3779db' : '#b7c4d5', width: 13, height: 13 }, interactionWidth: 18, focusable: true, ariaLabel: `${memberById.get(flow.fromId)?.title} către ${memberById.get(flow.toId)?.title}: ${flowLabels[flow.kind]}`, deletable: false };
  });
  const openRelation = (edge: Edge) => {
    const flow = edge.data?.flow as MemberFlow | undefined;
    if (flow) onSelectRelation?.(flow.fromId === focusId ? flow.toId : flow.fromId);
  };
  const reset = () => {
    setNodes(current => current.map((node, index) => ({ ...node, position: seedPosition(index) })));
    writeCanvas(workspace.project.id, { positions: {}, viewport: undefined });
    requestAnimationFrame(() => void flowInstance.current?.fitView({ padding: .12, maxZoom: 1, duration: 200 }));
  };
  if (!members.length) return <section className="team-people-map team-people-map-empty"><strong>Nu există persoane înregistrate.</strong><p>Adaugă membrii pentru a construi harta.</p></section>;

  return <section className="team-people-map" aria-label="Harta relațiilor dintre membrii echipei">
    <div className="tpm-toolbar"><span>{members.length} persoane <i /> {flows.length} legături de lucru</span><button type="button" aria-pressed={!showAll} onClick={() => setShowAll(value => !value)}>{showAll ? 'Relațiile persoanei' : 'Toate relațiile'}</button></div>
    <div className="tpm-canvas" aria-label="Canvas cu oameni conectați">
      <ReactFlow<PersonNode, Edge> key={workspace.project.id} nodes={displayNodes} edges={edges} nodeTypes={nodeTypes} onNodesChange={changes => { onNodesChange(changes); const selection = changes.find(change => change.type === 'select' && change.selected); if (selection?.type === 'select' && selection.id !== focusId) onSelectMember(selection.id); }}
        onNodeClick={(_, node) => onSelectMember(node.id)} onEdgeClick={(_, edge) => openRelation(edge)}
        onEdgesChange={changes => { const selection = changes.find(change => change.type === 'select' && change.selected); if (selection?.type === 'select') { const edge = edges.find(item => item.id === selection.id); if (edge) openRelation(edge); } }}
        onNodeDragStop={(_, __, draggedNodes) => { const current = flowInstance.current?.getNodes() || draggedNodes; writeCanvas(workspace.project.id, { positions: Object.fromEntries(current.map(node => [node.id, node.position])) }); }}
        onMoveEnd={(_, viewport) => writeCanvas(workspace.project.id, { viewport })}
        onInit={instance => { flowInstance.current = instance; }}
        fitView={!initialViewport} defaultViewport={initialViewport} fitViewOptions={{ padding: .12, maxZoom: 1 }} minZoom={.2} maxZoom={2} nodesConnectable={false} edgesReconnectable={false} deleteKeyCode={null} nodeDragThreshold={4} panOnDrag zoomOnScroll zoomOnPinch zoomOnDoubleClick={false} preventScrolling={false} attributionPosition="bottom-right">
        <Background variant={BackgroundVariant.Lines} gap={28} size={.5} color="#e6ecf3" />
        <Controls showInteractive={false} fitViewOptions={{ padding: .12, maxZoom: 1 }} aria-label="Zoom și încadrare" />
        <Panel position="top-right"><button type="button" className="tpm-reset" onClick={reset}>Reașază</button></Panel>
        <Panel position="bottom-center"><span className="tpm-canvas-hint">Mută oamenii · trage fundalul · zoom</span></Panel>
      </ReactFlow>
    </div>
    <label className="tpm-mobile-picker">Persoană<select value={focusId || ''} onChange={event => onSelectMember(event.target.value)}>{members.map(member => <option key={member.id} value={member.id}>{member.title}</option>)}</select></label>
    <footer className="tpm-foot"><span>Selectează o persoană sau o legătură.</span><span>{unresolvedCount ? `${unresolvedCount} dependențe cu responsabil de clarificat. ` : ''}{workspace.project.synthetic ? 'Proiect demonstrativ · portrete generate' : 'Legături din sarcinile proiectului'}</span></footer>
  </section>;
}
