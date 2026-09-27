import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from 'react';
import { Maximize2, Minus, Play, Plus } from 'lucide-react';
import { workingDateAtOffset, type SimulationResult, type SimulationPath, type SimulationCalendar } from '../../shared/simulation';

interface Props {
  stages: SimulationResult['stages']; paths: SimulationPath[]; selectedPathId: string | null;
  selectedStageId: string | null; calendar: SimulationCalendar;
  onSelect: (id: string) => void; onSelectStage: (pathId: string, taskId: string) => void;
}
const labels = { shorter: 'Mai devreme', central: 'În jurul estimării', later: 'Mai târziu' };
const colors = { shorter: '#527fbe', central: '#289b84', later: '#c78170' };
const familyOrder = ['shorter', 'central', 'later'] as const;
const dateLabel = new Intl.DateTimeFormat('ro-RO', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

/** The sampled data determines the curves. Selection and hover never rebuild their geometry. */
function buildGeometry(stages: Props['stages'], paths: SimulationPath[], compact: boolean, calendar: SimulationCalendar) {
  const width = compact ? 720 : 1160;
  const height = compact ? 420 : 620;
  const originX = compact ? 78 : 70;
  const originY = compact ? 210 : 310;
  const innerEnd = compact ? 610 : 1020;
  const centers = compact ? { shorter: 86, central: 210, later: 334 } : { shorter: 120, central: 337, later: 514 };
  const groups = new Map(familyOrder.map(id => [id, paths.filter(path => path.familyId === id).sort((a, b) => a.completionDays - b.completionDays)]));
  const completionMin = Math.min(...paths.map(path => path.completionDays));
  const completionSpan = Math.max(.01, Math.max(...paths.map(path => path.completionDays)) - completionMin);
  const branches = paths.map(path => {
    const group = groups.get(path.familyId)!;
    const rank = group.findIndex(item => item.id === path.id);
    const representative = rank === Math.floor(group.length / 2);
    const spread = path.familyId === 'shorter' ? (compact ? 82 : 116) : path.familyId === 'later' ? (compact ? 104 : 146) : (compact ? 60 : 80);
    const familySpread = group.length > 1 ? (rank / (group.length - 1) - .5) * spread : 0;
    const endpointX = innerEnd + (compact ? 10 : 18) + (path.completionDays - completionMin) / completionSpan * (compact ? 62 : 78);
    const endpointY = centers[path.familyId] + familySpread;
    const tasks = new Map(path.tasks.map(task => [task.id, task]));
    const points = stages.map((stage, index) => {
      const p = (index + 1) / (stages.length + 1);
      const nearby = stages.slice(Math.max(0, index - 1), Math.min(stages.length, index + 2));
      const signal = nearby.reduce((sum, item) => {
        const sample = tasks.get(item.id);
        return sum + (sample ? Math.max(-2, Math.min(2, (sample.finishDays - item.finishDays.p50) / Math.max(.6, item.finishDays.p90 - item.finishDays.p10))) : 0);
      }, 0) / nearby.length;
      const drift = signal * (compact ? 34 : 49) * Math.sin(Math.PI * p) + familySpread * Math.pow(p, 3.7);
      return { x: originX + p * (innerEnd - originX), y: originY + (centers[path.familyId] - originY) * (1 - Math.pow(1 - p, 2.5)) + drift, task: tasks.get(stage.id) };
    });
    const allPoints = [{ x: originX, y: originY }, ...points, { x: endpointX, y: endpointY }];
    const curve = allPoints.reduce((value, point, index) => {
      if (!index) return `M ${point.x} ${point.y}`;
      const previous = allPoints[index - 1];
      const mid = (previous.x + point.x) / 2;
      return `${value} C ${mid} ${previous.y}, ${mid} ${point.y}, ${point.x} ${point.y}`;
    }, '');
    const date = workingDateAtOffset(calendar, path.completionDays);
    return { path, points, curve, endpointX, endpointY, representative, color: colors[path.familyId], date, displayDate: dateLabel.format(new Date(`${date}T00:00:00Z`)), delay: rank * 22 + familyOrder.indexOf(path.familyId) * 45 };
  });
  return { width, height, originX, originY, centers, branches };
}

export default function SampledBranchMap({ stages, paths, selectedPathId, selectedStageId, calendar, onSelect, onSelectStage }: Props) {
  const plotRef = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [compact, setCompact] = useState(() => window.matchMedia('(max-width: 600px)').matches);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [replay, setReplay] = useState(0);
  const [manualPlayback, setManualPlayback] = useState(false);
  const lastCompact = useRef(compact);
  const drag = useRef<{ x: number; y: number; panX: number; panY: number; scaleX: number; scaleY: number } | null>(null);
  const queuedPan = useRef(pan);
  const panFrame = useRef(0);
  const { width, height, originX, originY, centers, branches } = useMemo(() => buildGeometry(stages, paths, compact, calendar), [stages, paths, compact, calendar]);
  useEffect(() => {
    const plot = plotRef.current;
    if (!plot) return;
    const observer = new ResizeObserver(([entry]) => setCompact(entry.contentRect.width <= 540));
    observer.observe(plot);
    return () => { observer.disconnect(); cancelAnimationFrame(panFrame.current); };
  }, []);
  useEffect(() => {
    if (lastCompact.current === compact) return;
    lastCompact.current = compact;
    setZoom(1); setPan({ x: 0, y: 0 });
  }, [compact]);
  useEffect(() => setHoveredId(null), [selectedPathId, selectedStageId]);
  useEffect(() => {
    if (!manualPlayback) return;
    const duration = Math.max(0, ...branches.map(branch => branch.delay)) + 1370;
    const timer = window.setTimeout(() => setManualPlayback(false), duration);
    return () => window.clearTimeout(timer);
  }, [manualPlayback, replay, branches]);
  if (!stages.length || !paths.length) return <div className="tc-sim-branch-empty">Nu sunt încă trasee în acest rezultat.</div>;
  const viewWidth = width / zoom, viewHeight = height / zoom;
  const maxPanX = (width - viewWidth) / 2, maxPanY = (height - viewHeight) / 2;
  const viewX = maxPanX + Math.max(-maxPanX, Math.min(maxPanX, pan.x));
  const viewY = maxPanY + Math.max(-maxPanY, Math.min(maxPanY, pan.y));
  const selectKey = (event: KeyboardEvent, action: () => void) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); action(); } };
  const beginDrag = (event: PointerEvent<SVGSVGElement>) => {
    if (zoom <= 1 || (event.target as Element).closest('[role="button"]')) return;
    const box = event.currentTarget.getBoundingClientRect();
    drag.current = { x: event.clientX, y: event.clientY, panX: pan.x, panY: pan.y, scaleX: viewWidth / box.width, scaleY: viewHeight / box.height };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const moveDrag = (event: PointerEvent<SVGSVGElement>) => {
    if (!drag.current) return;
    queuedPan.current = { x: drag.current.panX - (event.clientX - drag.current.x) * drag.current.scaleX, y: drag.current.panY - (event.clientY - drag.current.y) * drag.current.scaleY };
    if (!panFrame.current) panFrame.current = requestAnimationFrame(() => { panFrame.current = 0; setPan(queuedPan.current); });
  };
  const selectedBranch = branches.find(branch => branch.path.id === selectedPathId);
  return <div ref={plotRef} data-manual-replay={manualPlayback || undefined} className={`tc-sim-branch-plot tc-sim-organic-map${compact ? ' is-compact' : ''}`}>
    <svg viewBox={`${viewX} ${viewY} ${viewWidth} ${viewHeight}`} role="group" aria-label={`${paths.length} trasee simulate, selectabile`} onPointerDown={beginDrag} onPointerMove={moveDrag} onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }} style={{ touchAction: zoom > 1 ? 'none' : 'pan-y', cursor: zoom > 1 ? 'grab' : 'default' }}>
      <g className="tc-sim-stage-guides" aria-hidden="true">{[.26, .54, .82].map(fraction => <line key={fraction} x1={originX + (width - originX - 70) * fraction} x2={originX + (width - originX - 70) * fraction} y1={compact ? 32 : 42} y2={height - 48} />)}</g>
      <g key={replay} className="tc-sim-drawn-branches">
        {branches.map(({ path, points, curve, endpointX, endpointY, representative, color, date, delay }) => {
          const selected = selectedPathId === path.id, active = selected || hoveredId === path.id;
          const faded = Boolean(selectedPathId || hoveredId) && !active;
          return <g key={path.id} className={`tc-sim-route${selected ? ' is-selected' : ''}`} style={{ '--trace-delay': `${delay}ms`, '--route-color': color } as CSSProperties} onPointerEnter={event => { if (event.pointerType === 'mouse') setHoveredId(path.id); }} onPointerLeave={() => setHoveredId(null)}>
            <path d={curve} pathLength={1} className="tc-sim-route-halo tc-sim-trace" style={{ stroke: color, opacity: active ? .12 : 0 }} aria-hidden="true" />
            <path d={curve} className="tc-sim-branch-hit" tabIndex={0} role="button" aria-label={`Selectează rularea ${path.iteration + 1}, finalizare ${date}`} aria-pressed={selected} onClick={() => onSelect(path.id)} onFocus={() => setHoveredId(path.id)} onBlur={() => setHoveredId(null)} onKeyDown={event => selectKey(event, () => onSelect(path.id))} />
            <path d={curve} pathLength={1} className={`tc-sim-branch-line tc-sim-trace${active ? ' is-active' : ''}${selected ? ' is-selected' : ''}`} style={{ stroke: color, strokeWidth: active ? (compact ? 3 : 2.8) : representative ? (compact ? 2 : 1.9) : (compact ? 1.4 : 1.25), opacity: faded ? .16 : active ? 1 : representative ? .76 : .4 }} />
            {active && points.map(({ x, y, task }) => task && <circle key={task.id} className="tc-sim-stage-node" cx={x} cy={y} r={selectedStageId === task.id ? (compact ? 9 : 6) : (compact ? 6 : 3.5)} fill={color} stroke="#fff" strokeWidth={1.5} role="button" tabIndex={0} aria-label={`Selectează sarcina ${task.title}. Finalizare ${workingDateAtOffset(calendar, task.finishDays)}`} onClick={() => onSelectStage(path.id, task.id)} onKeyDown={event => selectKey(event, () => onSelectStage(path.id, task.id))}><title>{task.title} · {task.finishDays.toFixed(1)} zile</title></circle>)}
            <circle className="tc-sim-branch-endpoint" cx={endpointX} cy={endpointY} r={active ? (compact ? 9 : 5.5) : (compact ? 6 : 3.2)} fill={active ? color : '#fff'} stroke={color} strokeWidth={1.5} role="button" tabIndex={0} aria-pressed={selected} aria-label={`Selectează capătul rulării ${path.iteration + 1}, ${path.completionDays.toFixed(1)} zile`} onClick={() => onSelect(path.id)} onFocus={() => setHoveredId(path.id)} onBlur={() => setHoveredId(null)} onKeyDown={event => selectKey(event, () => onSelect(path.id))}><title>Scenariu #{path.iteration + 1} · {date}</title></circle>
          </g>;
        })}
      </g>
      <g className="tc-sim-origin" aria-hidden="true"><circle cx={originX} cy={originY} r={19} fill="#edf4f9" /><circle cx={originX} cy={originY} r={10} fill="#fff" stroke="#617b91" strokeWidth={1.4} /><circle cx={originX} cy={originY} r={3} fill="#617b91" /></g>
      <text x={originX} y={originY - 30} textAnchor="middle" className="tc-sim-origin-label">Planul de azi</text>
      {!compact && familyOrder.map(id => { const labelY = centers[id] + (id === 'later' ? 58 : -57); return <g key={id} className="tc-sim-family-map-label"><circle cx={416} cy={labelY - 5} r={3} fill={colors[id]} /><text x={430} y={labelY} fill={colors[id]}>{labels[id]}</text></g>; })}
      {!compact && <><text x={originX} y={600} className="tc-sim-branch-stage">Început</text><text x={590} y={600} textAnchor="middle" className="tc-sim-branch-stage">Etape și decizii</text><text x={1100} y={600} textAnchor="end" className="tc-sim-branch-stage">Finalizare</text></>}
    </svg>
    {compact && <div className="tc-sim-mobile-family-legend" aria-label="Grupuri de finalizare">{familyOrder.map(id => <span key={id} className={`family-${id}`}><i />{labels[id]}</span>)}</div>}
    <div className="tc-sim-map-bottom"><span className="tc-sim-map-selection" aria-live="polite">{selectedBranch ? <><i style={{ background: selectedBranch.color }} />Scenariul #{selectedBranch.path.iteration + 1}<span>{selectedBranch.displayDate}</span></> : 'Alege o ramură pentru detalii'}</span>
      <div className="tc-sim-map-tools" role="group" aria-label="Navigarea hărții"><button type="button" aria-label="Micșorează harta" title="Micșorează" disabled={zoom <= 1} onClick={() => setZoom(z => Math.max(1, z / 1.3))}><Minus size={14} /></button><span>{Math.round(zoom * 100)}%</span><button type="button" aria-label="Mărește harta" title="Mărește" disabled={zoom >= 3.5} onClick={() => setZoom(z => Math.min(3.5, z * 1.3))}><Plus size={14} /></button><button type="button" aria-label="Resetează harta" title="Încadrează harta" onClick={() => { setZoom(1); setPan({ x: 0, y: 0 }); }}><Maximize2 size={14} /></button><button type="button" className="tc-sim-replay" aria-label="Reia animația traseelor" onClick={() => { setManualPlayback(true); setReplay(value => value + 1); }}><Play size={13} />Redă traseele</button></div>
    </div>
  </div>;
}
