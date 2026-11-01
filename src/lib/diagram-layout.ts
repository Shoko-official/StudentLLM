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
type Arc = { edge: number; up: boolean; from: number; to: number; span: number; lane: number; ends: [End, End] };

const NODE_HALF_WIDTH = 84, NODE_HALF_HEIGHT = 36;
const LABEL_LIMIT = 26, CHAR_WIDTH = 7, LABEL_ABOVE = 12, LABEL_BELOW = 4, LABEL_STEP = 17;
const LANE_GAP = 28, LANE_OFFSET = 24, CORNER = 12, ARROW_GAP = 4, FACE_OFFSET = 14, GUTTER_START = 24, EDGE_MARGIN = 8;

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
  // One left-to-right pass: a node with forward predecessors moves to the mean of their rows, so crossings untangle where they can.
  // Only the slots of such nodes are reordered (stable), nodes without predecessors keep their reading order and place.
  const predecessors = visual.nodes.map(() => [] as number[]);
  for (const edge of visual.edges) { const from = index.get(edge.from)!, to = index.get(edge.to)!; if (levels[from] < levels[to]) predecessors[to].push(from); }
  const mean = (node: number) => predecessors[node].reduce((sum, item) => sum + row[item], 0) / predecessors[node].length;
  for (const [level, members] of [...columns].sort((x, y) => x[0] - y[0])) {
    if (level > 0) {
      const slots = members.flatMap((node, position) => predecessors[node].length ? [position] : []);
      const ordered = slots.map((position) => members[position]).sort((x, y) => mean(x) - mean(y));
      slots.forEach((position, order) => { members[position] = ordered[order]; });
    }
    members.forEach((node, position) => { row[node] = position; rows[node] = members.length; });
  }

  // Nodes paint over edges, so the gap between columns has to fit the widest label.
  const longestLabel = Math.max(0, ...visual.edges.map((edge) => Math.min(edge.label?.length ?? 0, LABEL_LIMIT)));
  const columnStep = Math.max(230, 176 + longestLabel * CHAR_WIDTH);
  const baseWidth = Math.max(580, columns.size * columnStep);
  const bodyHeight = Math.max(210, Math.max(...Array.from(columns.values(), (members) => members.length)) * 110 + 50);
  const nodeX = (node: number) => 100 + levels[node] * columnStep;
  const bodyY = (node: number) => 30 + (row[node] + .5) * (bodyHeight - 60) / rows[node];

  const texts = visual.edges.map((edge) => edge.label === undefined ? undefined : edge.label.length > LABEL_LIMIT ? `${edge.label.slice(0, LABEL_LIMIT - 1)}…` : edge.label);
  const arcs: Arc[] = [];
  visual.edges.forEach((edge, position) => {
    const from = index.get(edge.from)!, to = index.get(edge.to)!, step = levels[to] - levels[from];
    if (step === 1) return;
    // Forward skips pass above the node rows; backward edges and self-loops pass below. An edge between two
    // different nodes of one column cannot occur: a forward edge changes column and so does a back edge.
    const up = step >= 2;
    const extreme = (node: number) => up ? row[node] === 0 : row[node] === rows[node] - 1;
    const source: End = { node: from, role: 'source', side: extreme(from) ? 'edge' : step < 0 ? 'left' : 'right', offset: 0, gutter: 0 };
    const target: End = { node: to, role: 'target', side: extreme(to) ? 'edge' : step > 0 ? 'left' : 'right', offset: 0, gutter: 0 };
    arcs.push({ edge: position, up, from, to, span: Math.abs(nodeX(to) - nodeX(from)), lane: 0, ends: [source, target] });
  });

  // Shorter arcs take the inner lanes; arcs whose spans would touch never share one. A label always fits inside its span
  // or, for a self-loop, inside the column step, so it needs no room of its own here.
  for (const up of [true, false]) {
    const taken: Array<Array<[number, number]>> = [];
    for (const arc of arcs.filter((item) => item.up === up).sort((a, b) => a.span - b.span || a.edge - b.edge)) {
      const middle = (nodeX(arc.from) + nodeX(arc.to)) / 2, half = arc.span / 2 + 8;
      let lane = taken.findIndex((spans) => spans.every(([start, end]) => middle - half >= end || middle + half <= start));
      if (lane < 0) { lane = taken.length; taken.push([]); }
      taken[lane].push([middle - half, middle + half]);
      arc.lane = lane;
    }
  }

  const topMost = Math.min(...visual.nodes.map((_, node) => bodyY(node) - NODE_HALF_HEIGHT));
  const bottomMost = Math.max(...visual.nodes.map((_, node) => bodyY(node) + NODE_HALF_HEIGHT));

  type Entry = { arc: Arc; end: End };
  const groups = (select: (entry: Entry) => string | undefined) => {
    const map = new Map<string, Entry[]>();
    for (const arc of arcs) for (const end of arc.ends) { const key = select({ arc, end }); if (key !== undefined) map.set(key, [...(map.get(key) ?? []), { arc, end }]); }
    return map.values();
  };
  // Ends sharing a top or bottom face are spread so that nested arcs leave and arrive without crossing.
  for (const entries of groups(({ arc, end }) => end.side === 'edge' ? `${end.node}:${arc.up}` : undefined)) {
    const reach = ({ arc, end }: Entry) => nodeX(end.role === 'source' ? arc.to : arc.from) - nodeX(end.node);
    const group = (entry: Entry) => Math.sign(reach(entry)) + 1;
    const rank = (entry: Entry) => entry.end.role === 'source' ? 0 : 1;
    entries.sort((a, b) => group(a) - group(b) || reach(b) - reach(a) || rank(a) - rank(b));
    const spacing = Math.min(28, 120 / Math.max(entries.length - 1, 1));
    entries.forEach(({ end }, position) => { end.offset = (position - (entries.length - 1) / 2) * spacing; });
  }
  // Ends on a side face sit on the half of the face that faces their lane, clear of the arrows that use its middle,
  // and the innermost lane gets the slot nearest the middle so that the arcs of one face do not cross.
  for (const entries of groups(({ arc, end }) => end.side === 'edge' ? undefined : `${end.node}:${end.side}:${arc.up}`)) {
    const rank = (entry: Entry) => entry.end.role === 'target' ? 0 : 1;
    entries.sort((a, b) => a.arc.lane - b.arc.lane || rank(a) - rank(b));
    const spacing = Math.min(12, 18 / Math.max(entries.length - 1, 1));
    entries.forEach(({ arc, end }, position) => { end.offset = (arc.up ? -1 : 1) * (FACE_OFFSET + position * spacing); });
  }
  // Gutters start past the arrowheads of the arrows arriving at that face; within a column the nearer row gets the nearer gutter.
  for (const entries of groups(({ arc, end }) => end.side === 'edge' ? undefined : `${levels[end.node]}:${end.side}:${arc.up}`)) {
    entries.sort((a, b) => (a.arc.up ? -1 : 1) * (row[a.end.node] - row[b.end.node]) || Math.abs(a.end.offset) - Math.abs(b.end.offset));
    const spacing = Math.min(6, 24 / Math.max(entries.length - 1, 1));
    entries.forEach(({ end }, position) => { end.gutter = GUTTER_START + (entries.length - 1 - position) * spacing; });
  }

  const build = (dx: number, dy: number) => {
    const at = (node: number): Point => ({ x: dx + nodeX(node), y: dy + bodyY(node) });
    const laneY = (arc: Arc) => dy + (arc.up ? topMost - LANE_OFFSET - arc.lane * LANE_GAP : bottomMost + LANE_OFFSET + arc.lane * LANE_GAP);
    let right = dx + baseWidth, bottom = dy + bodyHeight;
    let left = dx + 100 - NODE_HALF_WIDTH, top = dy + topMost;
    const cover = (box: Box, margin: number) => { left = Math.min(left, box.l); top = Math.min(top, box.t); right = Math.max(right, box.r + margin); bottom = Math.max(bottom, box.b + margin); };

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
        const edgeY = center.y + vertical * NODE_HALF_HEIGHT, faceY = center.y + end.offset;
        const gutter = center.x + sign * (NODE_HALF_WIDTH + end.gutter);
        const stub = center.x + end.offset;
        if (end.role === 'source') halves.push(end.side === 'edge'
          ? [{ x: stub, y: edgeY }, { x: stub, y: lane }]
          : [{ x: center.x + sign * NODE_HALF_WIDTH, y: faceY }, { x: gutter, y: faceY }, { x: gutter, y: lane }]);
        else halves.push(end.side === 'edge'
          ? [{ x: stub, y: lane }, { x: stub, y: edgeY + vertical * ARROW_GAP }]
          : [{ x: gutter, y: lane }, { x: gutter, y: faceY }, { x: center.x + sign * (NODE_HALF_WIDTH + ARROW_GAP), y: faceY }]);
      }
      const points = halves.flat();
      points.forEach(({ x, y }) => cover({ l: x, r: x, t: y, b: y }, 6));
      edges[arc.edge].path = roundedPath(points);
      const text = texts[arc.edge];
      if (text !== undefined) {
        const start = halves[0][halves[0].length - 1].x, finish = halves[1][0].x;
        // The label sits on the lane at its apex. A run too short to show around it (a self-loop) takes the label just below the lane.
        const onLane = Math.abs(finish - start) >= text.length * CHAR_WIDTH + 24;
        labels.set(arc.edge, { text, x: round((start + finish) / 2), y: round(onLane ? lane + LABEL_BELOW : lane + LABEL_ABOVE + LABEL_BELOW + 4) });
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
      cover(box, 8);
      edges[position].label = label;
    });
    return { left, top, layout: { width: Math.ceil(right), height: Math.ceil(bottom), nodes: visual.nodes.map((node, position) => ({ id: node.id, ...at(position) })), edges } };
  };

  // Lanes, labels and paths may run past the top or left edge; everything then moves inward.
  const first = build(0, 0);
  if (first.left >= EDGE_MARGIN && first.top >= EDGE_MARGIN) return first.layout;
  return build(Math.ceil(Math.max(0, EDGE_MARGIN - first.left)), Math.ceil(Math.max(0, EDGE_MARGIN - first.top))).layout;
}
