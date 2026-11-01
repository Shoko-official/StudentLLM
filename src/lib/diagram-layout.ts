import type { TeachingDiagram } from './teaching-visuals';

export interface DiagramLayout {
  width: number;
  height: number;
  nodes: Array<{ id: string; x: number; y: number }>;
  // A label is anchored at the middle of its text baseline; its box is 7 units per character wide, 12 above the baseline and 4 below.
  edges: Array<{ path: string; label?: { text: string; x: number; y: number } }>;
}

type Point = { x: number; y: number };
type Box = { l: number; r: number; t: number; b: number };
type End = { node: number; role: 'source' | 'target'; side: 'edge' | 'left' | 'right'; offset: number; gutter: number };
type Arc = { edge: number; up: boolean; from: number; to: number; span: number; width: number; lane: number; ends: [End, End] };

const NODE_HALF_WIDTH = 84, NODE_HALF_HEIGHT = 36;
const LABEL_LIMIT = 26, CHAR_WIDTH = 7, LABEL_ABOVE = 12, LABEL_BELOW = 4, LABEL_STEP = 17;
const LANE_GAP = 28, LANE_OFFSET = 24, LANE_MARGIN = 14, CORNER = 12, ARROW_GAP = 4;

const round = (value: number) => Math.round(value * 100) / 100;
const overlaps = (a: Box, b: Box) => a.l < b.r && a.r > b.l && a.t < b.b && a.b > b.t;

// Back edges come from a depth-first search that starts at the roots in node order, so the rest is acyclic.
function layerNodes(visual: TeachingDiagram) {
  const index = new Map(visual.nodes.map((node, position) => [node.id, position]));
  const outgoing = visual.nodes.map(() => [] as number[]);
  const hasIncoming = new Set<number>();
  visual.edges.forEach((edge, position) => { outgoing[index.get(edge.from)!].push(position); hasIncoming.add(index.get(edge.to)!); });
  const state = visual.nodes.map(() => 0);
  const back = new Set<number>();
  const finished: number[] = [];
  const visit = (node: number) => {
    state[node] = 1;
    for (const position of outgoing[node]) {
      const target = index.get(visual.edges[position].to)!;
      if (state[target] === 1) back.add(position);
      else if (state[target] === 0) visit(target);
    }
    state[node] = 2; finished.push(node);
  };
  visual.nodes.forEach((_, node) => { if (!hasIncoming.has(node) && state[node] === 0) visit(node); });
  visual.nodes.forEach((_, node) => { if (state[node] === 0) visit(node); });
  const levels = visual.nodes.map(() => 0);
  for (const node of finished.reverse()) {
    for (const position of outgoing[node]) {
      if (back.has(position)) continue;
      const target = index.get(visual.edges[position].to)!;
      levels[target] = Math.max(levels[target], levels[node] + 1);
    }
  }
  return { index, levels };
}

function roundedPath(points: Point[]) {
  const kept = points.filter((point, position) => position === 0 || point.x !== points[position - 1].x || point.y !== points[position - 1].y);
  let path = `M${round(kept[0].x)} ${round(kept[0].y)}`;
  for (let position = 1; position < kept.length - 1; position++) {
    const previous = kept[position - 1], corner = kept[position], next = kept[position + 1];
    const before = Math.hypot(corner.x - previous.x, corner.y - previous.y), after = Math.hypot(next.x - corner.x, next.y - corner.y);
    const radius = Math.min(CORNER, before / 2, after / 2);
    path += ` L${round(corner.x - (corner.x - previous.x) / before * radius)} ${round(corner.y - (corner.y - previous.y) / before * radius)}`
      + ` Q${round(corner.x)} ${round(corner.y)} ${round(corner.x + (next.x - corner.x) / after * radius)} ${round(corner.y + (next.y - corner.y) / after * radius)}`;
  }
  const last = kept[kept.length - 1];
  return `${path} L${round(last.x)} ${round(last.y)}`;
}

export function layoutDiagram(visual: TeachingDiagram): DiagramLayout {
  const { index, levels } = layerNodes(visual);
  const columns = new Map<number, number[]>();
  visual.nodes.forEach((_, node) => columns.set(levels[node], [...(columns.get(levels[node]) ?? []), node]));
  const row = visual.nodes.map(() => 0), rows = visual.nodes.map(() => 1);
  for (const members of columns.values()) members.forEach((node, position) => { row[node] = position; rows[node] = members.length; });

  // Nodes paint over edges, so the gap between columns has to fit the widest label.
  const longestLabel = Math.max(0, ...visual.edges.map((edge) => Math.min(edge.label?.length ?? 0, LABEL_LIMIT)));
  const columnStep = Math.max(230, 176 + longestLabel * CHAR_WIDTH);
  let width = Math.max(580, columns.size * columnStep);
  const bodyHeight = Math.max(210, Math.max(...Array.from(columns.values(), (members) => members.length)) * 110 + 50);
  const nodeX = (node: number) => 100 + levels[node] * columnStep;
  const bodyY = (node: number) => 30 + (row[node] + .5) * (bodyHeight - 60) / rows[node];

  const texts = visual.edges.map((edge) => edge.label === undefined ? undefined : edge.label.length > LABEL_LIMIT ? `${edge.label.slice(0, LABEL_LIMIT - 1)}…` : edge.label);
  const arcs: Arc[] = [];
  visual.edges.forEach((edge, position) => {
    const from = index.get(edge.from)!, to = index.get(edge.to)!, step = levels[to] - levels[from];
    if (step === 1) return;
    // Forward skips pass above the node rows; backward, same-column and self edges pass below.
    const up = step >= 2;
    const extreme = (node: number) => up ? row[node] === 0 : row[node] === rows[node] - 1;
    const source: End = { node: from, role: 'source', side: extreme(from) ? 'edge' : step < 0 ? 'left' : 'right', offset: 0, gutter: 0 };
    const target: End = { node: to, role: 'target', side: extreme(to) ? 'edge' : step > 0 ? 'left' : 'right', offset: 0, gutter: step === 0 ? 16 : 0 };
    arcs.push({ edge: position, up, from, to, span: Math.abs(nodeX(to) - nodeX(from)), width: (texts[position]?.length ?? 0) * CHAR_WIDTH, lane: 0, ends: [source, target] });
  });

  // Shorter arcs take the inner lanes; arcs whose spans (or labels) would touch never share one.
  const laneCount = { up: 0, down: 0 };
  for (const up of [true, false]) {
    const taken: Array<Array<[number, number]>> = [];
    for (const arc of arcs.filter((item) => item.up === up).sort((a, b) => a.span - b.span || a.edge - b.edge)) {
      const middle = (nodeX(arc.from) + nodeX(arc.to)) / 2, half = Math.max(arc.span, arc.width) / 2 + 8;
      let lane = taken.findIndex((spans) => spans.every(([start, end]) => middle - half >= end || middle + half <= start));
      if (lane < 0) { lane = taken.length; taken.push([]); }
      taken[lane].push([middle - half, middle + half]);
      arc.lane = lane;
    }
    laneCount[up ? 'up' : 'down'] = taken.length;
  }

  const topMost = Math.min(...visual.nodes.map((_, node) => bodyY(node) - NODE_HALF_HEIGHT));
  const bottomMost = Math.max(...visual.nodes.map((_, node) => bodyY(node) + NODE_HALF_HEIGHT));
  const shift = laneCount.up ? Math.max(0, LANE_MARGIN - (topMost - LANE_OFFSET - (laneCount.up - 1) * LANE_GAP)) : 0;
  const laneY = (arc: Arc) => shift + (arc.up ? topMost - LANE_OFFSET - arc.lane * LANE_GAP : bottomMost + LANE_OFFSET + arc.lane * LANE_GAP);
  let height = Math.max(bodyHeight + shift, laneCount.down ? shift + bottomMost + LANE_OFFSET + (laneCount.down - 1) * LANE_GAP + LANE_MARGIN : 0);
  const at = (node: number): Point => ({ x: nodeX(node), y: shift + bodyY(node) });

  // Ends sharing a node face are spread so that nested arcs leave and arrive without crossing.
  const faces = new Map<string, Array<{ arc: Arc; end: End }>>();
  for (const arc of arcs) for (const end of arc.ends) {
    if (end.side !== 'edge') continue;
    const key = `${end.node}:${arc.up}`;
    faces.set(key, [...(faces.get(key) ?? []), { arc, end }]);
  }
  for (const entries of faces.values()) {
    const reach = ({ arc, end }: { arc: Arc; end: End }) => nodeX(end.role === 'source' ? arc.to : arc.from) - nodeX(end.node);
    const group = (entry: { arc: Arc; end: End }) => Math.sign(reach(entry)) + 1;
    const rank = (entry: { end: End }) => entry.end.role === 'source' ? 0 : 1;
    entries.sort((a, b) => group(a) - group(b) || reach(b) - reach(a) || rank(a) - rank(b));
    const spacing = Math.min(28, 120 / Math.max(entries.length - 1, 1));
    entries.forEach(({ end }, position) => { end.offset = (position - (entries.length - 1) / 2) * spacing; });
  }

  const edges: DiagramLayout['edges'] = visual.edges.map(() => ({ path: '' }));
  const labels = new Map<number, { text: string; x: number; y: number }>();
  visual.edges.forEach((edge, position) => {
    const from = at(index.get(edge.from)!), to = at(index.get(edge.to)!);
    if (levels[index.get(edge.to)!] - levels[index.get(edge.from)!] !== 1) return;
    const x1 = from.x + NODE_HALF_WIDTH, x2 = to.x - NODE_HALF_WIDTH - ARROW_GAP;
    edges[position].path = `M${round(x1)} ${round(from.y)} C${round(x1 + 55)} ${round(from.y)},${round(x2 - 55)} ${round(to.y)},${round(x2)} ${round(to.y)}`;
    const text = texts[position];
    if (text !== undefined) labels.set(position, { text, x: round((x1 + x2) / 2), y: round((from.y + to.y) / 2 - 9) });
  });
  for (const arc of arcs) {
    const lane = laneY(arc), halves: Point[][] = [];
    const vertical = arc.up ? -1 : 1;
    for (const end of arc.ends) {
      const center = at(end.node), sign = end.side === 'left' ? -1 : 1;
      const edgeY = center.y + vertical * NODE_HALF_HEIGHT;
      // A self-loop on an inner row uses the lower half of the right face, clear of the edges that leave from its middle.
      const faceY = center.y + (arc.from === arc.to ? (end.role === 'source' ? 28 : 12) : 0);
      const gutter = center.x + sign * (NODE_HALF_WIDTH + 12 + (arc.lane % 4) * 5 + end.gutter);
      const stub = center.x + end.offset;
      if (end.role === 'source') halves.push(end.side === 'edge'
        ? [{ x: stub, y: edgeY }, { x: stub, y: lane }]
        : [{ x: center.x + sign * NODE_HALF_WIDTH, y: faceY }, { x: gutter, y: faceY }, { x: gutter, y: lane }]);
      else halves.push(end.side === 'edge'
        ? [{ x: stub, y: lane }, { x: stub, y: edgeY + vertical * ARROW_GAP }]
        : [{ x: gutter, y: lane }, { x: gutter, y: faceY }, { x: center.x + sign * (NODE_HALF_WIDTH + ARROW_GAP), y: faceY }]);
    }
    edges[arc.edge].path = roundedPath(halves.flat());
    const text = texts[arc.edge];
    if (text !== undefined) {
      const start = halves[0][halves[0].length - 1].x, finish = halves[1][0].x;
      // The label sits on the lane at its apex; a run too short to show around it takes the label just clear of the lane.
      const onLane = Math.abs(finish - start) >= text.length * CHAR_WIDTH + 24;
      labels.set(arc.edge, { text, x: round((start + finish) / 2), y: round(onLane ? lane + LABEL_BELOW : lane + (arc.up ? -LABEL_ABOVE : LABEL_ABOVE + LABEL_BELOW + 4)) });
    }
  }

  // Labels are placed in edge order; one that lands on a node or an earlier label moves down until it is clear.
  const obstacles: Box[] = visual.nodes.map((_, node) => { const { x, y } = at(node); return { l: x - NODE_HALF_WIDTH, r: x + NODE_HALF_WIDTH, t: y - NODE_HALF_HEIGHT, b: y + NODE_HALF_HEIGHT }; });
  const boxOf = ({ text, x, y }: { text: string; x: number; y: number }): Box => ({ l: x - text.length * CHAR_WIDTH / 2, r: x + text.length * CHAR_WIDTH / 2, t: y - LABEL_ABOVE, b: y + LABEL_BELOW });
  visual.edges.forEach((_, position) => {
    const label = labels.get(position);
    if (!label) return;
    for (let attempt = 0; attempt < 200 && obstacles.some((box) => overlaps(boxOf(label), box)); attempt++) label.y += LABEL_STEP;
    const box = boxOf(label);
    obstacles.push(box);
    width = Math.max(width, Math.ceil(box.r + 8));
    height = Math.max(height, Math.ceil(box.b + 8));
    edges[position].label = label;
  });

  return { width, height, nodes: visual.nodes.map((node, position) => ({ id: node.id, ...at(position) })), edges };
}
