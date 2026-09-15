import type { VisualBlock, VisualChart, VisualDiagram, VisualTable } from './visual-blocks';
import { RichText } from './rich-text';

function titleFor(visual: VisualBlock) {
  return visual.title || (visual.type === 'chart' ? 'Course chart' : visual.type === 'diagram' ? 'Course diagram' : 'Course table');
}

function ChartView({ visual }: { visual: VisualChart }) {
  const title = titleFor(visual);
  const width = 560;
  const height = 260;
  const chartLeft = 44;
  const chartTop = 28;
  const chartWidth = width - 72;
  const chartHeight = height - 72;
  const maximum = Math.max(...visual.values.map((item) => Math.abs(item.value)), 1);
  const minimum = Math.min(0, ...visual.values.map((item) => item.value));
  const range = Math.max(maximum - minimum, 1);
  const xFor = (index: number) => chartLeft + (index + 0.5) * (chartWidth / visual.values.length);
  const yFor = (value: number) => chartTop + chartHeight - ((value - minimum) / range) * chartHeight;
  const zeroY = yFor(0);

  if (visual.chartType === 'pie') {
    const total = visual.values.reduce((sum, item) => sum + Math.abs(item.value), 0) || 1;
    let start = -Math.PI / 2;
    const radius = 78;
    const centerX = 190;
    const centerY = 124;
    const slices = visual.values.map((item, index) => {
      const angle = Math.abs(item.value) / total * Math.PI * 2;
      const end = start + angle;
      const largeArc = angle > Math.PI ? 1 : 0;
      const path = `M ${centerX} ${centerY} L ${centerX + radius * Math.cos(start)} ${centerY + radius * Math.sin(start)} A ${radius} ${radius} 0 ${largeArc} 1 ${centerX + radius * Math.cos(end)} ${centerY + radius * Math.sin(end)} Z`;
      const slice = { item, index, path };
      start = end;
      return slice;
    });
    return <figure className="visual-block visual-chart" aria-label={title}>
      <figcaption>{title}</figcaption>
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={title}>
        {slices.map(({ item, index, path }) => <path key={`${item.label}-${index}`} className="visual-pie-slice" data-index={index} d={path}><title>{`${item.label}: ${item.value}`}</title></path>)}
        <g className="visual-legend">
          {visual.values.map((item, index) => <text key={`${item.label}-legend`} x="310" y={48 + index * 26}>{`${item.label}: ${item.value}`}</text>)}
        </g>
      </svg>
      <small className="visual-source">Source: {visual.sourceLabel ?? visual.sourceId}{visual.sourcePage ? ` · page ${visual.sourcePage}` : ''}</small>
    </figure>;
  }

  const points = visual.values.map((item, index) => `${xFor(index)},${yFor(item.value)}`).join(' ');
  return <figure className="visual-block visual-chart" aria-label={title}>
    <figcaption>{title}</figcaption>
    <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={title}>
      <line className="visual-axis" x1={chartLeft} y1={chartTop} x2={chartLeft} y2={chartTop + chartHeight} />
      <line className="visual-axis" x1={chartLeft} y1={zeroY} x2={chartLeft + chartWidth} y2={zeroY} />
      {visual.chartType === 'line' && <polyline className="visual-line" points={points} />}
      {visual.values.map((item, index) => {
        const x = xFor(index);
        const y = yFor(item.value);
        const barWidth = Math.max(12, chartWidth / visual.values.length * 0.58);
        return visual.chartType === 'line'
          ? <circle className="visual-point" key={`${item.label}-${index}`} cx={x} cy={y} r="5"><title>{`${item.label}: ${item.value}`}</title></circle>
          : <rect className="visual-bar" key={`${item.label}-${index}`} x={x - barWidth / 2} y={Math.min(y, zeroY)} width={barWidth} height={Math.max(1, Math.abs(zeroY - y))} rx="2"><title>{`${item.label}: ${item.value}`}</title></rect>;
      })}
      {visual.values.map((item, index) => <text className="visual-axis-label" key={`${item.label}-axis`} x={xFor(index)} y={chartTop + chartHeight + 24} textAnchor="middle">{item.label}</text>)}
    </svg>
    <small className="visual-source">Source: {visual.sourceLabel ?? visual.sourceId}{visual.sourcePage ? ` · page ${visual.sourcePage}` : ''}</small>
  </figure>;
}

function DiagramView({ visual }: { visual: VisualDiagram }) {
  const title = titleFor(visual);
  const width = 560;
  const height = Math.max(180, Math.ceil(visual.nodes.length / 3) * 100 + 50);
  const positions = new Map(visual.nodes.map((node, index) => [node.id, {
    x: 100 + (index % 3) * 180,
    y: 70 + Math.floor(index / 3) * 100,
  }]));
  const markerId = `visual-arrow-${visual.sourceId.replace(/[^a-z0-9_-]/gi, '-')}`;
  return <figure className="visual-block visual-diagram" aria-label={title}>
    <figcaption>{title}</figcaption>
    <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={title}>
      <defs><marker id={markerId} markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 Z" /></marker></defs>
      {visual.edges.map((edge, index) => {
        const from = positions.get(edge.from);
        const to = positions.get(edge.to);
        if (!from || !to) return null;
        return <g key={`${edge.from}-${edge.to}-${index}`}>
          <line className="visual-edge" x1={from.x} y1={from.y} x2={to.x} y2={to.y} markerEnd={`url(#${markerId})`} />
          {edge.label && <text className="visual-edge-label" x={(from.x + to.x) / 2} y={(from.y + to.y) / 2 - 6} textAnchor="middle">{edge.label}</text>}
        </g>;
      })}
      {visual.nodes.map((node) => {
        const position = positions.get(node.id)!;
        return <g key={node.id} className="visual-node" transform={`translate(${position.x - 64} ${position.y - 22})`}>
          <rect width="128" height="44" rx="5" />
          <text x="64" y="27" textAnchor="middle">{node.label}</text>
        </g>;
      })}
    </svg>
    <small className="visual-source">Source: {visual.sourceLabel ?? visual.sourceId}{visual.sourcePage ? ` · page ${visual.sourcePage}` : ''}</small>
  </figure>;
}

function TableView({ visual }: { visual: VisualTable }) {
  const title = titleFor(visual);
  return <figure className="visual-block visual-table">
    <figcaption>{title}</figcaption>
    <table aria-label={title}>
      <thead><tr>{visual.columns.map((column) => <th key={column} scope="col"><RichText content={column} /></th>)}</tr></thead>
      <tbody>{visual.rows.map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, cellIndex) => <td key={`${rowIndex}-${cellIndex}`}><RichText content={cell} /></td>)}</tr>)}</tbody>
    </table>
    <small className="visual-source">Source: {visual.sourceLabel ?? visual.sourceId}{visual.sourcePage ? ` · page ${visual.sourcePage}` : ''}</small>
  </figure>;
}

export function VisualBlockView({ visual }: { visual: VisualBlock }) {
  if (visual.type === 'chart') return <ChartView visual={visual} />;
  if (visual.type === 'diagram') return <DiagramView visual={visual} />;
  return <TableView visual={visual} />;
}
