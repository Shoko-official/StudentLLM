import { useId, useMemo, useState } from 'react';
import { compileExpression, type TeachingVisual } from './teaching-visuals';
import { RichText } from './rich-text';
import './teaching-visual-view.css';

type Plot = Extract<TeachingVisual, { type: 'plot' }>;
type Diagram = Extract<TeachingVisual, { type: 'diagram' }>;
type Figure = Extract<TeachingVisual, { type: 'figure' }>;
type Quiz = Extract<TeachingVisual, { type: 'quiz' }>;
const SAMPLE_COUNT = 161;
const DASHES = ['', '9 4', '3 4', '11 3 2 3'];

function numberLabel(value: number) {
  if (!Number.isFinite(value)) return 'Undefined';
  if (value === 0) return '0';
  return Math.abs(value) >= 100_000 || Math.abs(value) < .001
    ? value.toExponential(3)
    : Number(value.toPrecision(5)).toLocaleString('en', { maximumFractionDigits: 8 });
}

function PlotView({ visual }: { visual: Plot }) {
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const [dataOpen, setDataOpen] = useState(false);
  const [parameters, setParameters] = useState<Record<string, number>>(() => Object.fromEntries((visual.parameters ?? []).map((parameter) => [parameter.name, parameter.value])));
  const functions = useMemo(() => visual.series.map((series) => series.expression === undefined ? null : compileExpression(series.expression)), [visual]);
  const outputFunctions = useMemo(() => (visual.outputs ?? []).map((output) => compileExpression(output.expression)), [visual]);
  // Four series, 161 samples each, and the evaluator's per-call budget bound the total work.
  const sampled = useMemo(() => visual.series.map((series, index) => ({
    label: series.label,
    points: series.points ?? Array.from({ length: visual.x.step ? Math.min(SAMPLE_COUNT, Math.floor((visual.x.max - visual.x.min) / visual.x.step + 1e-9) + 1) : SAMPLE_COUNT }, (_, sample) => {
      const x = visual.x.step ? visual.x.min + sample * visual.x.step : visual.x.min + sample / (SAMPLE_COUNT - 1) * (visual.x.max - visual.x.min);
      return [x, functions[index]?.({ ...parameters, x }) ?? NaN] as [number, number];
    }),
  })), [visual, functions, parameters]);
  const validPoint = ([x, y]: [number, number]) => Number.isFinite(x) && Number.isFinite(y) && Math.abs(y) < 1e100;
  const finiteValues = sampled.flatMap((series) => series.points.filter((point) => validPoint(point) && point[0] >= visual.x.min && point[0] <= visual.x.max).map(([, y]) => y));
  let minY = visual.y?.min ?? Math.min(...finiteValues, ...(visual.chartType === 'bar' ? [0] : []));
  let maxY = visual.y?.max ?? Math.max(...finiteValues, ...(visual.chartType === 'bar' ? [0] : []));
  if (!Number.isFinite(minY) || !Number.isFinite(maxY)) { minY = -1; maxY = 1; }
  if (minY === maxY) { const padding = Math.max(Math.abs(minY) * .1, 1); minY -= padding; maxY += padding; }
  if (!visual.y) { const padding = (maxY - minY) * .06; minY -= padding; maxY += padding; }
  const width = 640, height = 330, left = 76, right = 24, top = 20, bottom = 64;
  const plotWidth = width - left - right, plotHeight = height - top - bottom;
  const gaps = sampled.flatMap((series) => series.points.slice(1).map(([x], index) => x - series.points[index][0]).filter((gap) => gap > 0));
  const spacing = Math.min(...gaps, visual.x.max - visual.x.min);
  // Keep the first and last discrete bars whole while retaining their numeric x positions.
  const xPadding = visual.chartType === 'bar' ? spacing / 2 : 0;
  const xSpan = visual.x.max - visual.x.min + xPadding * 2;
  const xFor = (x: number) => left + (x - visual.x.min + xPadding) / xSpan * plotWidth;
  const yFor = (y: number) => top + (maxY - y) / (maxY - minY) * plotHeight;
  let hasGaps = false;
  const paths = sampled.map((series, seriesIndex) => {
    let previous: [number, number] | null = null;
    return series.points.map((point) => {
      if (!validPoint(point)) { previous = null; hasGaps = true; return ''; }
      // A jump between opposite sides of the viewport can be an asymptote, not a connecting line.
      const jump = previous !== null && previous[1] * point[1] < 0 && Math.abs(point[1] - previous[1]) > (maxY - minY) * .7;
      const midpoint = jump && visual.series[seriesIndex].expression ? functions[seriesIndex]?.({ ...parameters, x: (previous![0] + point[0]) / 2 }) : undefined;
      const discontinuity = jump && midpoint !== undefined && (!Number.isFinite(midpoint) || Math.abs(midpoint - (previous![1] + point[1]) / 2) > (maxY - minY) * .5);
      if (discontinuity) hasGaps = true;
      const command = previous && !discontinuity ? 'L' : 'M';
      previous = point;
      return `${command}${xFor(point[0])},${yFor(point[1])}`;
    }).join(' ');
  });
  const zeroY = yFor(Math.min(maxY, Math.max(minY, 0)));
  const ticks = Array.from({ length: 5 }, (_, index) => index / 4);
  return <figure className="teaching-visual teaching-plot" aria-labelledby={`${id}-title`}>
    <figcaption><strong id={`${id}-title`}>{visual.title}</strong><span className="teaching-kind">{visual.parameters?.length ? 'Interactive graph' : 'Graph'}</span></figcaption>
    {visual.description && <p className="teaching-description">{visual.description}</p>}
    {!!visual.parameters?.length && <div className="teaching-controls">{visual.parameters.map((parameter) => <div className="teaching-control" key={parameter.name}>
      <div><label htmlFor={`${id}-${parameter.name}`}>{parameter.label}</label><output htmlFor={`${id}-${parameter.name}`} aria-hidden="true">{numberLabel(parameters[parameter.name])}</output></div>
      <input id={`${id}-${parameter.name}`} type="range" min={parameter.min} max={parameter.max} step={parameter.step} value={parameters[parameter.name]} onChange={(event) => setParameters((current) => ({ ...current, [parameter.name]: Number(event.target.value) }))} />
      <small>{numberLabel(parameter.min)} - {numberLabel(parameter.max)}</small>
    </div>)}</div>}
    <div className="teaching-canvas" tabIndex={0} role="region" aria-label={`${visual.title}: scrollable graph`}>
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${visual.title}. ${sampled.map((series) => series.label).join(', ')}. Sampled values are available below.`}>
        <defs><clipPath id={`${id}-clip`}><rect x={left} y={top} width={plotWidth} height={plotHeight} /></clipPath></defs>
        {ticks.map((fraction) => <g key={`y-${fraction}`}>
          <line className="teaching-gridline" x1={left} x2={width - right} y1={top + fraction * plotHeight} y2={top + fraction * plotHeight} />
          <text className="teaching-tick" x={left - 10} y={top + fraction * plotHeight + 4} textAnchor="end">{numberLabel(maxY - fraction * (maxY - minY))}</text>
        </g>)}
        {ticks.map((fraction) => <text className="teaching-tick" key={`x-${fraction}`} x={xFor(visual.x.min + fraction * (visual.x.max - visual.x.min))} y={height - bottom + 24} textAnchor="middle">{numberLabel(visual.x.min + fraction * (visual.x.max - visual.x.min))}</text>)}
        <line className="teaching-axis" x1={left} x2={width - right} y1={zeroY} y2={zeroY} />
        <line className="teaching-axis" x1={left} x2={left} y1={top} y2={height - bottom} />
        <g clipPath={`url(#${id}-clip)`}>{sampled.map((series, index) => visual.chartType === 'bar'
          ? <g className={`teaching-series teaching-series-${index}`} key={index}>{series.points.filter(validPoint).map(([x, y], sample) => {
            const barWidth = Math.max(1, plotWidth * spacing / xSpan * .7 / sampled.length);
            return <rect key={sample} x={xFor(x) - barWidth * sampled.length / 2 + index * barWidth} y={Math.min(yFor(y), zeroY)} width={barWidth} height={Math.abs(yFor(y) - zeroY)}><title>{`${series.label}: ${numberLabel(x)}, ${numberLabel(y)}`}</title></rect>;
          })}</g>
          : <path key={index} className={`teaching-series teaching-series-${index}`} data-series={series.label} d={paths[index]} strokeDasharray={DASHES[index]} fill="none" />)}</g>
        <text className="teaching-axis-title" x={left + plotWidth / 2} y={height - 12} textAnchor="middle">{visual.x.label ?? 'x'}</text>
        {visual.y?.label && <text className="teaching-axis-title" transform={`translate(15 ${top + plotHeight / 2}) rotate(-90)`} textAnchor="middle">{visual.y.label}</text>}
      </svg>
    </div>
    <ul className="teaching-legend" aria-label="Graph series">{sampled.map((series, index) => <li key={index}><svg width="30" height="12" aria-hidden="true"><line className={`teaching-series teaching-series-${index}`} x1="0" x2="30" y1="6" y2="6" strokeDasharray={DASHES[index]} /></svg><span>{series.label}</span></li>)}</ul>
    {!!visual.outputs?.length && <dl className="teaching-outputs">{visual.outputs.map((output, index) => <div key={index}><dt>{output.label}</dt><dd>{numberLabel(outputFunctions[index]?.(parameters) ?? NaN)}{output.unit ? ` ${output.unit}` : ''}</dd></div>)}</dl>}
    {hasGaps && <p className="teaching-note">Undefined values and detected discontinuities are shown as gaps.</p>}
    <details className="teaching-data" onToggle={(event) => setDataOpen(event.currentTarget.open)}><summary>Read graph values</summary>{dataOpen && <div className="teaching-table-scroll" tabIndex={0} role="region" aria-label="Graph values"><table><caption>Values for the current parameters</caption><thead><tr><th scope="col">Series</th><th scope="col">{visual.x.label ?? 'x'}</th><th scope="col">Value</th></tr></thead><tbody>{sampled.flatMap((series, seriesIndex) => series.points.map(([x, y], index) => <tr key={`${seriesIndex}-${index}`}><th scope="row">{series.label}</th><td>{numberLabel(x)}</td><td>{numberLabel(y)}</td></tr>))}</tbody></table></div>}</details>
  </figure>;
}

function wrapLabel(label: string, length = 22, maxLines = 3) {
  const words = label.split(/\s+/).flatMap((word) => word.match(/.{1,22}/gu) ?? []);
  const lines: string[] = [''];
  for (const word of words) {
    const current = lines[lines.length - 1];
    if (current && current.length + word.length + 1 > length) lines.push(word);
    else lines[lines.length - 1] = current ? `${current} ${word}` : word;
  }
  if (lines.length > maxLines) return [...lines.slice(0, maxLines - 1), `${lines[maxLines - 1].slice(0, length - 1)}…`];
  return lines;
}

function DiagramView({ visual }: { visual: Diagram }) {
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const incoming = new Map(visual.nodes.map((node) => [node.id, 0]));
  for (const edge of visual.edges) incoming.set(edge.to, (incoming.get(edge.to) ?? 0) + 1);
  const queue = visual.nodes.filter((node) => !incoming.get(node.id)).map((node) => node.id);
  const levels = new Map(visual.nodes.map((node) => [node.id, 0]));
  let processed = 0;
  for (let index = 0; index < queue.length; index++) {
    const node = queue[index]; processed++;
    for (const edge of visual.edges.filter((item) => item.from === node)) {
      levels.set(edge.to, Math.max(levels.get(edge.to)!, levels.get(node)! + 1));
      incoming.set(edge.to, incoming.get(edge.to)! - 1);
      if (incoming.get(edge.to) === 0) queue.push(edge.to);
    }
  }
  const cyclic = processed !== visual.nodes.length;
  const groups = new Map<number, typeof visual.nodes>();
  visual.nodes.forEach((node, index) => { const level = cyclic ? index % 3 : levels.get(node.id)!; groups.set(level, [...(groups.get(level) ?? []), node]); });
  const width = Math.max(580, groups.size * 230);
  const height = Math.max(210, Math.max(...Array.from(groups.values(), (nodes) => nodes.length)) * 110 + 50);
  const positions = new Map<string, { x: number; y: number }>();
  for (const [level, nodes] of groups) nodes.forEach((node, index) => positions.set(node.id, { x: 100 + level * 230, y: 30 + (index + .5) * (height - 60) / nodes.length }));
  const names = new Map(visual.nodes.map((node) => [node.id, node.label]));
  return <figure className="teaching-visual teaching-diagram" aria-labelledby={`${id}-title`}>
    <figcaption><strong id={`${id}-title`}>{visual.title}</strong><span className="teaching-kind">Diagram</span></figcaption>
    {visual.description && <p className="teaching-description">{visual.description}</p>}
    <div className="teaching-canvas" tabIndex={0} role="region" aria-label={`${visual.title}: scrollable diagram`}>
      <svg viewBox={`0 0 ${width} ${height}`} style={{ minWidth: width }} role="img" aria-label={`${visual.title}. Relationships are listed below.`}>
        <defs><marker id={`${id}-arrow`} markerWidth="9" markerHeight="9" refX="8" refY="4.5" orient="auto"><path d="M0 0 L9 4.5 L0 9 Z" className="teaching-arrowhead" /></marker></defs>
        {visual.edges.map((edge, index) => {
          const from = positions.get(edge.from)!, to = positions.get(edge.to)!;
          const forward = to.x >= from.x;
          const x1 = from.x + (forward ? 84 : -84), x2 = to.x + (forward ? -88 : 88);
          return <g key={index}><path className="teaching-edge" d={`M${x1} ${from.y} C${x1 + (forward ? 55 : -55)} ${from.y},${x2 - (forward ? 55 : -55)} ${to.y},${x2} ${to.y}`} markerEnd={`url(#${id}-arrow)`} />{edge.label && <text className="teaching-edge-label" x={(x1 + x2) / 2} y={(from.y + to.y) / 2 - 9} textAnchor="middle">{edge.label.length > 26 ? `${edge.label.slice(0, 25)}…` : edge.label}</text>}</g>;
        })}
        {visual.nodes.map((node) => { const position = positions.get(node.id)!; const lines = wrapLabel(node.label); return <g className="teaching-node" key={node.id} transform={`translate(${position.x - 84} ${position.y - 36})`}><rect width="168" height="72" rx="7" /><title>{node.label}</title><text x="84" y={40 - (lines.length - 1) * 8} textAnchor="middle">{lines.map((line, index) => <tspan key={index} x="84" dy={index ? 16 : 0}>{line}</tspan>)}</text></g>; })}
      </svg>
    </div>
    <details className="teaching-data"><summary>Read diagram relationships</summary><ul>{visual.edges.length ? visual.edges.map((edge, index) => <li key={index}>{names.get(edge.from)} → {names.get(edge.to)}{edge.label ? `: ${edge.label}` : ''}</li>) : visual.nodes.map((node) => <li key={node.id}>{node.label}</li>)}</ul></details>
  </figure>;
}

function FigureView({ visual }: { visual: Figure }) {
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  return <figure className="teaching-visual teaching-figure" aria-labelledby={`${id}-title`}>
    <figcaption><strong id={`${id}-title`}>{visual.title}</strong><span className="teaching-kind">Illustration</span></figcaption>
    {visual.description && <p className="teaching-description">{visual.description}</p>}
    <div className="teaching-canvas" tabIndex={0} role="region" aria-label={`${visual.title}: scrollable illustration`}>
      <svg viewBox={`0 0 ${visual.width} ${visual.height}`} style={{ minWidth: visual.width }} role="img" aria-label={`${visual.title}${visual.description ? `. ${visual.description}` : ''}`}>
        <defs><marker id={`${id}-arrow`} markerWidth="9" markerHeight="9" refX="8" refY="4.5" orient="auto"><path d="M0 0 L9 4.5 L0 9 Z" className="teaching-arrowhead" /></marker></defs>
        {visual.shapes.map((shape, index) => {
          if (shape.type === 'text') return <text className="teaching-figure-text" key={index} x={shape.x} y={shape.y}>{shape.text}</text>;
          const color = `teaching-color-${shape.color ?? 'blue'}`;
          if (shape.type === 'rect') return <g key={index} className={color}><rect className="teaching-shape" x={shape.x} y={shape.y} width={shape.width} height={shape.height} rx="4" />{shape.label && <text className="teaching-figure-text" x={shape.x + shape.width / 2} y={shape.y + shape.height / 2 + 4} textAnchor="middle">{shape.label}</text>}</g>;
          if (shape.type === 'circle') return <g key={index} className={color}><circle className="teaching-shape" cx={shape.x} cy={shape.y} r={shape.r} />{shape.label && <text className="teaching-figure-text" x={shape.x} y={shape.y + 4} textAnchor="middle">{shape.label}</text>}</g>;
          return <g key={index} className={color}><line className="teaching-figure-line" x1={shape.x1} y1={shape.y1} x2={shape.x2} y2={shape.y2} markerEnd={shape.type === 'arrow' ? `url(#${id}-arrow)` : undefined} />{shape.label && <text className="teaching-figure-text" x={(shape.x1 + shape.x2) / 2} y={(shape.y1 + shape.y2) / 2 - 9} textAnchor="middle">{shape.label}</text>}</g>;
        })}
      </svg>
    </div>
    <details className="teaching-data"><summary>Read illustration labels</summary><ul>{visual.shapes.flatMap((shape, index) => shape.type === 'text' ? [<li key={index}>{shape.text}</li>] : shape.label ? [<li key={index}>{shape.label}</li>] : [])}</ul></details>
  </figure>;
}

function QuizView({ visual }: { visual: Quiz }) {
  const id = useId();
  const [selected, setSelected] = useState<number | null>(null);
  const [checked, setChecked] = useState(false);
  return <figure className="teaching-visual teaching-quiz" aria-labelledby={`${id}-title`}>
    <figcaption><strong id={`${id}-title`}>{visual.title}</strong><span className="teaching-kind">Practice</span></figcaption>
    <RichText content={visual.question} />
    <fieldset><legend>Choose one answer</legend>{visual.options.map((option, index) => <label className="teaching-option" key={index}><input type="radio" name={`${id}-answer`} aria-label={option} checked={selected === index} onChange={() => { setSelected(index); setChecked(false); }} /><RichText content={option} /></label>)}</fieldset>
    <div className="teaching-quiz-actions"><button type="button" className="secondary-action" disabled={selected === null} onClick={() => setChecked(true)}>Check answer</button><button type="button" className="text-action" onClick={() => { setSelected(null); setChecked(false); }}>Start again</button></div>
    {visual.hint && <details className="teaching-data"><summary>Show hint</summary><RichText content={visual.hint} /></details>}
    <p className="teaching-feedback" role="status" aria-live="polite">{checked ? selected === visual.answer ? 'Correct according to this exercise.' : 'That differs from the expected answer. Try again or read the explanation.' : ''}</p>
    {checked && <details className="teaching-data"><summary>Read explanation</summary><p>Expected answer: {visual.answer + 1}</p><RichText content={visual.explanation} /></details>}
    <p className="teaching-note">AI-generated exercise. Check important answers against your course.</p>
  </figure>;
}

export function TeachingVisualView({ visual }: { visual: TeachingVisual }) {
  if (visual.type === 'plot') return <PlotView visual={visual} />;
  if (visual.type === 'diagram') return <DiagramView visual={visual} />;
  if (visual.type === 'figure') return <FigureView visual={visual} />;
  return <QuizView visual={visual} />;
}
