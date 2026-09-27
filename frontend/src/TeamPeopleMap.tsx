import React, { useId, useMemo } from 'react';
import type { ProjectRecord, ProjectWorkspace, SourceRef } from '../../shared/types';
import './team-people-map.css';

type Props = {
  workspace: ProjectWorkspace;
  selectedMemberId: string | null;
  onSelectMember: (id: string) => void;
};

type FlowKind = 'handoff' | 'review' | 'approval' | 'unknown';
type Point = { x: number; y: number };
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

function memberPositions(memberIds: string[], focusId: string | null) {
  const focusIndex = Math.max(0, memberIds.findIndex((id) => id === focusId));
  const ordered = [...memberIds.slice(focusIndex), ...memberIds.slice(0, focusIndex)];
  const positions = new Map<string, Point>();
  if (!ordered.length) return positions;
  positions.set(ordered[0], { x: 50, y: 50 });
  const ring = ordered.slice(1);
  ring.forEach((id, index) => {
    const angle = -Math.PI / 2 + (index * Math.PI * 2) / Math.max(1, ring.length);
    positions.set(id, {
      x: 50 + Math.cos(angle) * 35,
      y: 50 + Math.sin(angle) * 34,
    });
  });
  return positions;
}

function clippedSegment(from: Point, to: Point) {
  const ax = from.x * 10;
  const ay = from.y * 6.4;
  const bx = to.x * 10;
  const by = to.y * 6.4;
  const dx = bx - ax;
  const dy = by - ay;
  const length = Math.max(1, Math.hypot(dx, dy));
  const ux = dx / length;
  const uy = dy / length;
  const clip = (vx: number, vy: number) => 1 / Math.max(Math.abs(vx) / 132, Math.abs(vy) / 92);
  const startDistance = clip(ux, uy);
  const endDistance = clip(-ux, -uy);
  return {
    start: { x: ax + ux * startDistance, y: ay + uy * startDistance },
    end: { x: bx - ux * endDistance, y: by - uy * endDistance },
  };
}

function avatarPosition(member: ProjectRecord) {
  let crop = member.avatar_crop || 'top-left';
  if (member.avatar_is_illustrative && crop === 'bottom-left') crop = 'bottom-right';
  else if (member.avatar_is_illustrative && crop === 'bottom-right') crop = 'bottom-left';
  return ({
    'top-left': '0% 0%',
    'top-right': '100% 0%',
    'bottom-left': '0% 100%',
    'bottom-right': '100% 100%',
  } as const)[crop];
}

export default function TeamPeopleMap({ workspace, selectedMemberId, onSelectMember }: Props) {
  const markerPrefix = useId().replace(/:/g, '');
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

  const focusId = members.some((member) => member.id === selectedMemberId) ? selectedMemberId : members[0]?.id || null;
  const positions = memberPositions(members.map((member) => member.id), focusId);
  const workCount = (memberId: string) => records.filter((record) => memberFor(record) === memberId).length;
  const edgeColors: Record<FlowKind, string> = { handoff: '#28a879', review: '#3177d2', approval: '#8a60b0', unknown: '#8492a1' };

  if (!members.length) return <section className="team-people-map team-people-map-empty"><strong>Nu există persoane înregistrate.</strong><p>Harta va apărea când proiectul are membri și dependențe documentate.</p></section>;

  return <section className="team-people-map" aria-label="Harta relațiilor dintre membrii echipei">
    <div className="tpm-stage" aria-label="Membrii și relațiile lor de lucru">
      <svg className="tpm-edges" viewBox="0 0 1000 640" preserveAspectRatio="none" aria-hidden="true">
        <defs>
          {Object.entries(edgeColors).map(([kind, color]) => <marker key={kind} id={`${markerPrefix}-${kind}`} markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill={color} /></marker>)}
        </defs>
        {flows.map((flow, index) => {
          const from = positions.get(flow.fromId);
          const to = positions.get(flow.toId);
          if (!from || !to) return null;
          const { start, end } = clippedSegment(from, to);
          const dx = end.x - start.x;
          const dy = end.y - start.y;
          const length = Math.max(1, Math.hypot(dx, dy));
          const midpoint = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 };
          const unrelatedToFocus = flow.fromId !== focusId && flow.toId !== focusId;
          const centerDistance = Math.hypot(midpoint.x - 500, midpoint.y - 320);
          const px = -dy / length; const py = dx / length;
          const outwardDot = (midpoint.x - 500) * px + (midpoint.y - 320) * py;
          const sign = Math.abs(outwardDot) < 1 ? (index % 2 === 0 ? 1 : -1) : outwardDot >= 0 ? 1 : -1;
          const curveOffset = unrelatedToFocus && centerDistance < 205 ? 360 : ((index % 3) - 1) * 28;
          const cx = midpoint.x - (dy / length) * curveOffset * sign;
          const cy = midpoint.y + (dx / length) * curveOffset * sign;
          const labelT = flow.fromId === focusId ? 0.62 : 0.38;
          const inverseT = 1 - labelT;
          const lx = inverseT * inverseT * start.x + 2 * inverseT * labelT * cx + labelT * labelT * end.x;
          const ly = inverseT * inverseT * start.y + 2 * inverseT * labelT * cy + labelT * labelT * end.y;
          const involved = !selectedMemberId || flow.fromId === selectedMemberId || flow.toId === selectedMemberId;
          const showLabel = flow.fromId === focusId || flow.toId === focusId;
          const label = flowLabels[flow.kind];
          return <g key={flow.key} className={`tpm-flow tpm-flow-${flow.kind}`} opacity={involved ? 0.95 : 0.7}>
            <title>{`${memberById.get(flow.fromId)?.title} către ${memberById.get(flow.toId)?.title}: ${label.toLocaleLowerCase()}, ${flow.tasks.length} ${flow.tasks.length === 1 ? 'sarcină' : 'sarcini'}${flow.sources.length ? `, ${flow.sources.length} ${flow.sources.length === 1 ? 'citat' : 'citate'}` : ', fără citat de relație'}`}</title>
            <path d={`M ${start.x} ${start.y} Q ${cx} ${cy} ${end.x} ${end.y}`} stroke={edgeColors[flow.kind]} markerEnd={`url(#${markerPrefix}-${flow.kind})`} />
            {showLabel && <g className="tpm-edge-label" transform={`translate(${lx},${ly})`}>
              <rect x="-54" y={flow.sources.length ? '-18' : '-12'} width="108" height={flow.sources.length ? '36' : '24'} rx="12" />
              <text y={flow.sources.length ? '-3' : '4'}>{label} · {flow.tasks.length}</text>
              {flow.sources.length > 0 && <text className="tpm-edge-source-count" y="10">{flow.sources.length} {flow.sources.length === 1 ? 'sursă' : 'surse'}</text>}
            </g>}
          </g>;
        })}
      </svg>
      {members.map((member) => {
        const position = positions.get(member.id)!;
        const selected = member.id === selectedMemberId;
        const isFocus = member.id === focusId;
        const illustration = member.avatar_is_illustrative;
        return <button
          className={`tpm-member${selected ? ' tpm-member-selected' : ''}${isFocus ? ' tpm-member-focus' : ''}`}
          key={member.id}
          type="button"
          style={{ left: `${position.x}%`, top: `${position.y}%` }}
          aria-pressed={selected}
          aria-label={`${member.title}, ${member.role || 'rol neînregistrat'}, ${workCount(member.id)} sarcini alocate`}
          onClick={() => onSelectMember(member.id)}
        >
          {member.avatar_asset ? <span className="tpm-avatar tpm-avatar-image" aria-hidden="true" title={illustration ? 'Portret ilustrativ pentru scenariul sintetic' : undefined} style={{ backgroundImage: `url(${member.avatar_asset})`, backgroundPosition: avatarPosition(member) }} /> : <span className="tpm-avatar" aria-hidden="true">{member.title.split(/\s+/).map((part) => part[0]).slice(0, 2).join('').toLocaleUpperCase()}</span>}
          <span className="tpm-member-copy"><strong>{member.title}</strong><small>{member.role || 'Rol neînregistrat'}</small><em>{workCount(member.id)} {workCount(member.id) === 1 ? 'sarcină alocată' : 'sarcini alocate'}</em></span>
          {illustration && <span className="tpm-illustrative-mark" aria-label="Portret ilustrativ">ilustrativ</span>}
        </button>;
      })}
      {!flows.length && <div className="tpm-no-flows">Nu există încă legături documentate între responsabili diferiți.</div>}
    </div>
    <div className="tpm-mobile-relations" aria-label="Relații agregate">
      {flows.length ? flows.map((flow) => <article key={flow.key} className={`tpm-mobile-relation tpm-mobile-${flow.kind}`}>
        <strong>{memberById.get(flow.fromId)?.title}</strong><span>{flowLabels[flow.kind]} · {flow.tasks.length}</span><strong>{memberById.get(flow.toId)?.title}</strong>
        <small>{flow.tasks.join(' · ')}{flow.sources.length ? ` · ${flow.sources.length} surse legate` : ''}</small>
      </article>) : <p>Nu există încă legături documentate între responsabili diferiți.</p>}
    </div>
    <footer className="tpm-foot">
      <div className="tpm-legend" aria-label="Tipuri de relații"><span><i className="tpm-legend-handoff" />Predare</span><span><i className="tpm-legend-review" />Revizuire</span><span><i className="tpm-legend-approval" />Aprobare</span><span><i className="tpm-legend-unknown" />Dependență fără tip clar</span></div>
      <p className="tpm-note">{unresolvedCount ? `${unresolvedCount} dependențe fără doi responsabili identificați rămân neconectate. ` : ''}Legăturile derivă din dependențe și responsabili înregistrați. Citatele se deschid în profilul sau sarcina implicată.</p>
    </footer>
  </section>;
}
