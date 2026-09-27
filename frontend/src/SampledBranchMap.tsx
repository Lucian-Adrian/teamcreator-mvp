import { useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { workingDateAtOffset, type SimulationResult, type SimulationPath, type SimulationCalendar } from '../../shared/simulation';

interface Props {
  stages: SimulationResult['stages']; paths: SimulationPath[]; selectedPathId: string | null;
  hoveredPathId: string | null; selectedStageId: string | null; calendar: SimulationCalendar;
  onSelect: (id: string) => void; onSelectStage: (pathId: string, taskId: string) => void;
  onHover: (id: string | null) => void;
}
const labels = { shorter: 'Mai devreme', central: 'În jurul estimării', later: 'Mai târziu' };

export default function SampledBranchMap({ stages, paths, selectedPathId, hoveredPathId, selectedStageId, calendar, onSelect, onSelectStage, onHover }: Props) {
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const drag = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null);
  if (!stages.length || !paths.length) return <div className="tc-sim-branch-empty">Nu sunt încă trasee în acest rezultat.</div>;
  const width = 1160, height = 620, originX = 70, originY = 310, innerEnd = 1020;
  const viewWidth = width / zoom, viewHeight = height / zoom;
  const maxPanX = (width - viewWidth) / 2, maxPanY = (height - viewHeight) / 2;
  const viewX = maxPanX + Math.max(-maxPanX, Math.min(maxPanX, pan.x));
  const viewY = maxPanY + Math.max(-maxPanY, Math.min(maxPanY, pan.y));
  const colors = { shorter: '#5682c4', central: '#40a28c', later: '#cf806e' };
  const centers = { shorter: 120, central: 337, later: 514 };
  const completionMin = Math.min(...paths.map(p => p.completionDays));
  const completionSpan = Math.max(.01, Math.max(...paths.map(p => p.completionDays)) - completionMin);
  const familyMembers = (id: SimulationPath['familyId']) => paths.filter(p => p.familyId === id).sort((a,b) => a.completionDays - b.completionDays);
  const representatives = new Set((['shorter','central','later'] as const).map(id => { const group = familyMembers(id); return group[Math.floor(group.length / 2)]?.id; }));
  const xAt = (index: number) => originX + ((index + 1) / (stages.length + 1)) * (innerEnd - originX);
  const selectKey = (event: KeyboardEvent, action: () => void) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); action(); } };
  const beginDrag = (event: PointerEvent<SVGSVGElement>) => {
    if (zoom <= 1 || (event.target as Element).closest('[role="button"]')) return;
    drag.current = { x: event.clientX, y: event.clientY, panX: pan.x, panY: pan.y };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const moveDrag = (event: PointerEvent<SVGSVGElement>) => {
    if (!drag.current) return;
    const box = event.currentTarget.getBoundingClientRect();
    setPan({ x: drag.current.panX - (event.clientX - drag.current.x) * viewWidth / box.width, y: drag.current.panY - (event.clientY - drag.current.y) * viewHeight / box.height });
  };
  return <div className="tc-sim-branch-plot tc-sim-organic-map">
    <svg viewBox={`${viewX} ${viewY} ${viewWidth} ${viewHeight}`} role="group" aria-label={`${paths.length} trasee simulate, selectabile`} onPointerDown={beginDrag} onPointerMove={moveDrag} onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }} style={{ touchAction: zoom > 1 ? 'none' : 'pan-y', cursor: zoom > 1 ? 'grab' : 'default' }}>
      {paths.map(path => {
        const group = familyMembers(path.familyId), rank = group.findIndex(p => p.id === path.id);
        const familySpread = group.length > 1 ? (rank / (group.length - 1) - .5) * (path.familyId === 'shorter' ? 116 : path.familyId === 'later' ? 146 : 80) : 0;
        const endpointX = innerEnd + 18 + (path.completionDays - completionMin) / completionSpan * 78;
        const points = stages.map((stage,index) => {
          const task = path.tasks.find(t => t.id === stage.id);
          const p = (index + 1) / (stages.length + 1);
          const nearby = stages.slice(Math.max(0,index-1),Math.min(stages.length,index+2));
          // Layout deviations follow each real run's stage timings relative to the full-sample stage quantiles.
          const signal = nearby.reduce((sum, item) => { const sample = path.tasks.find(t => t.id === item.id); return sum + (sample ? Math.max(-2,Math.min(2,(sample.finishDays-item.finishDays.p50)/Math.max(.6,item.finishDays.p90-item.finishDays.p10))) : 0); },0) / nearby.length;
          const opening = 1 - Math.pow(1-p,2.5);
          const drift = signal * 49 * Math.sin(Math.PI*p) + familySpread * Math.pow(p,3.7);
          return { x:xAt(index), y:originY+(centers[path.familyId]-originY)*opening+drift, task };
        });
        const allPoints = [{x:originX,y:originY},...points,{x:endpointX,y:centers[path.familyId]+familySpread}];
        const curve = allPoints.reduce((value,point,index) => { if(!index)return `M ${point.x} ${point.y}`; const prev=allPoints[index-1]; const mid=(prev.x+point.x)/2; return value+` C ${mid} ${prev.y}, ${mid} ${point.y}, ${point.x} ${point.y}`; },'');
        const selected = selectedPathId === path.id, active = selected || hoveredPathId === path.id;
        const faded = Boolean(selectedPathId || hoveredPathId) && !active;
        return <g key={path.id} onMouseEnter={() => onHover(path.id)} onMouseLeave={() => onHover(null)}>
          <path d={curve} className="tc-sim-branch-hit" tabIndex={0} role="button" aria-label={`Selectează rularea ${path.iteration+1}, finalizare ${workingDateAtOffset(calendar,path.completionDays)}`} aria-pressed={selected} onClick={() => onSelect(path.id)} onFocus={() => onHover(path.id)} onBlur={() => onHover(null)} onKeyDown={event => selectKey(event,() => onSelect(path.id))} />
          <path d={curve} className="tc-sim-branch-line" style={{stroke:colors[path.familyId],strokeWidth:active ? 3 : representatives.has(path.id) ? 2 : 1.3,opacity:faded ? .18 : active ? 1 : representatives.has(path.id) ? .65 : .32}} />
          {active && points.map(({x,y,task}) => task && <circle key={task.id} className="tc-sim-stage-node" cx={x} cy={y} r={selectedStageId===task.id ? 6 : 3.5} fill={colors[path.familyId]} stroke="#fff" strokeWidth={1.3} role="button" tabIndex={0} aria-label={`Selectează sarcina ${task.title}. Finalizare ${workingDateAtOffset(calendar,task.finishDays)}`} onClick={() => onSelectStage(path.id,task.id)} onKeyDown={event => selectKey(event,() => onSelectStage(path.id,task.id))}><title>{task.title} · {task.finishDays.toFixed(1)} zile</title></circle>)}
          <circle className="tc-sim-branch-endpoint" cx={endpointX} cy={centers[path.familyId]+familySpread} r={active ? 5.5 : 3.2} fill={active ? colors[path.familyId] : '#fff'} stroke={colors[path.familyId]} strokeWidth={1.3} role="button" tabIndex={0} aria-pressed={selected} aria-label={`Selectează capătul rulării ${path.iteration+1}, ${path.completionDays.toFixed(1)} zile`} onClick={() => onSelect(path.id)} onFocus={() => onHover(path.id)} onBlur={() => onHover(null)} onKeyDown={event => selectKey(event,() => onSelect(path.id))}><title>Scenariu #{path.iteration+1} · {workingDateAtOffset(calendar,path.completionDays)}</title></circle>
        </g>;
      })}
      <circle cx={originX} cy={originY} r={8} fill="white" stroke="#526577" strokeWidth={1.7} />
      <text x={originX-3} y={originY-23} textAnchor="middle" className="tc-sim-origin-label">Planul de azi</text>
      {(['shorter','central','later'] as const).map(id => <g key={id} className="tc-sim-family-map-label"><rect x={420} y={centers[id]-38} width={174} height={31} fill="white" opacity={.94} rx={4}/><text x={429} y={centers[id]-18} fill={colors[id]}>{labels[id]}</text></g>)}
      <text x={originX} y={600} className="tc-sim-branch-stage">Început</text><text x={590} y={600} textAnchor="middle" className="tc-sim-branch-stage">Etape și decizii</text><text x={1100} y={600} textAnchor="end" className="tc-sim-branch-stage">Finalizare</text>
    </svg>
    <div className="tc-sim-map-tools" role="group" aria-label="Navigarea hărții"><button aria-label="Micșorează harta" disabled={zoom<=1} onClick={() => setZoom(z=>Math.max(1,z/1.3))}>−</button><span>{Math.round(zoom*100)}%</span><button aria-label="Mărește harta" disabled={zoom>=3.5} onClick={() => setZoom(z=>Math.min(3.5,z*1.3))}>+</button><button aria-label="Resetează harta" onClick={() => {setZoom(1);setPan({x:0,y:0});}}>Resetare</button>{zoom>1&&<small>Trage harta pentru deplasare</small>}</div>
  </div>;
}
