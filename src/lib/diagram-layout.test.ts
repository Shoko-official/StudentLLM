import { layoutDiagram } from './diagram-layout';
import type { TeachingDiagram } from './teaching-visuals';

// Geometry contract: nodes are 168x72 boxes centred on their position, a label is anchored
// at its text baseline, 7 units per visible character and 16 high (12 above the baseline).
interface Box { l: number; r: number; t: number; b: number }
const nodeBox = ({ x, y }: { x: number; y: number }): Box => ({ l: x - 84, r: x + 84, t: y - 36, b: y + 36 });
const labelBox = ({ text, x, y }: { text: string; x: number; y: number }): Box => ({ l: x - text.length * 3.5, r: x + text.length * 3.5, t: y - 12, b: y + 4 });
const overlap = (a: Box, b: Box) => a.l < b.r && a.r > b.l && a.t < b.b && a.b > b.t;

function diagram(ids: string[], edges: Array<[string, string, string?]>): TeachingDiagram {
  return { type: 'diagram', title: 'Test', nodes: ids.map((id) => ({ id, label: id.toUpperCase() })), edges: edges.map(([from, to, label]) => ({ from, to, ...(label === undefined ? {} : { label }) })) };
}

type Pt = [number, number];

// Samples the absolute M, L, C and Q commands that the layout emits, about every unit along each segment.
function samplePath(path: string): Pt[] {
  const tokens = path.match(/[MLCQ]|-?\d+(?:\.\d+)?/g)!;
  const points: Pt[] = [];
  let position = 0, command = '';
  const read = (): Pt => [Number(tokens[position++]), Number(tokens[position++])];
  while (position < tokens.length) {
    if (/[MLCQ]/.test(tokens[position])) command = tokens[position++];
    const from = points[points.length - 1];
    if (command === 'M') { points.push(read()); continue; }
    const controls = command === 'L' ? [] : command === 'Q' ? [read()] : [read(), read()];
    const to = read();
    const chain = [from, ...controls, to];
    const steps = Math.max(2, Math.ceil(Math.hypot(to[0] - from[0], to[1] - from[1]) / 2));
    for (let step = 1; step <= steps; step++) {
      const t = step / steps;
      let level = chain;
      while (level.length > 1) level = level.slice(1).map((point, index) => [level[index][0] + (point[0] - level[index][0]) * t, level[index][1] + (point[1] - level[index][1]) * t] as Pt);
      points.push(level[0]);
    }
  }
  return points;
}

const arrowHead = (points: Pt[]) => {
  const end = points[points.length - 1], before = points[Math.max(0, points.length - 6)];
  const length = Math.hypot(end[0] - before[0], end[1] - before[1]) || 1;
  return Array.from({ length: 10 }, (_, step) => [end[0] - (end[0] - before[0]) / length * step, end[1] - (end[1] - before[1]) / length * step] as Pt);
};
const distance = (a: Pt, b: Pt) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const turn = (a: Pt, b: Pt, c: Pt) => Math.sign((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]));
// Touching counts: the samples of axis-aligned runs often meet exactly on the other line.
const crosses = (first: Pt[], second: Pt[]) => first.slice(1).some((end, index) => second.slice(1).some((other, at) => {
  const [a, b, c, d] = [first[index], end, second[at], other];
  const apart = Math.max(a[0], b[0]) < Math.min(c[0], d[0]) || Math.max(c[0], d[0]) < Math.min(a[0], b[0]) || Math.max(a[1], b[1]) < Math.min(c[1], d[1]) || Math.max(c[1], d[1]) < Math.min(a[1], b[1]);
  return !apart && turn(a, b, c) * turn(a, b, d) <= 0 && turn(c, d, a) * turn(c, d, b) <= 0;
}));
const isArc = (path: string) => path.includes('Q');

function expectReadable(visual: TeachingDiagram, strict = true) {
  const layout = layoutDiagram(visual);
  const nodes = layout.nodes.map(nodeBox);
  const labels = layout.edges.flatMap((edge) => edge.label ? [labelBox(edge.label)] : []);
  expect(layout.nodes).toHaveLength(visual.nodes.length);
  expect(layout.edges).toHaveLength(visual.edges.length);
  expect(new Set(layout.nodes.map(({ x, y }) => `${x},${y}`)).size).toBe(visual.nodes.length);
  labels.forEach((label, index) => {
    nodes.forEach((node) => expect(overlap(label, node)).toBe(false));
    labels.slice(0, index).forEach((earlier) => expect(overlap(label, earlier)).toBe(false));
  });
  [...nodes, ...labels].forEach((box) => {
    expect(box.l).toBeGreaterThanOrEqual(0);
    expect(box.t).toBeGreaterThanOrEqual(0);
    expect(box.r).toBeLessThanOrEqual(layout.width);
    expect(box.b).toBeLessThanOrEqual(layout.height);
  });
  layout.edges.forEach((edge) => expect(edge.path).not.toMatch(/NaN|Infinity|undefined/));
  const samples = layout.edges.map((edge) => samplePath(edge.path));
  samples.forEach((points) => {
    expect(points.every(([x, y]) => x >= 0 && y >= 0 && x <= layout.width && y <= layout.height)).toBe(true);
    expect(points.some(([x, y]) => nodes.some((node) => x > node.l + 1 && x < node.r - 1 && y > node.t + 1 && y < node.b - 1))).toBe(false);
  });
  if (strict) {
    visual.edges.forEach((first, one) => visual.edges.forEach((second, two) => {
      // An arc never starts where an arrow arrives, and no line runs through another arrow's head.
      if (first.from === second.to) expect(distance(samples[one][0], samples[two][samples[two].length - 1])).toBeGreaterThanOrEqual(12);
      if (one === two || distance(samples[one][samples[one].length - 1], samples[two][samples[two].length - 1]) < 1) return;
      const head = arrowHead(samples[two]);
      expect(Math.min(...samples[one].flatMap((point) => head.map((spot) => distance(point, spot))))).toBeGreaterThanOrEqual(7);
    }));
    const arcs = samples.filter((_, edge) => isArc(layout.edges[edge].path));
    arcs.forEach((first, one) => arcs.slice(one + 1).forEach((second) => {
      expect(distance(first[0], second[0])).toBeGreaterThanOrEqual(6);
      expect(distance(first[first.length - 1], second[second.length - 1])).toBeGreaterThanOrEqual(6);
    }));
  }
  return layout;
}

const nextColumnCurve = (from: { x: number; y: number }, to: { x: number; y: number }) => {
  const x1 = from.x + 84, x2 = to.x - 88;
  return `M${x1} ${from.y} C${x1 + 55} ${from.y},${x2 - 55} ${to.y},${x2} ${to.y}`;
};
const ys = (path: string) => (path.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number).filter((_, index) => index % 2 === 1);

describe('diagram layout', () => {
  it('cuts labels over 26 characters to 25 and an ellipsis', () => {
    const layout = layoutDiagram({ type: 'diagram', title: 'Cut', nodes: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], edges: [{ from: 'a', to: 'b', label: 'x'.repeat(26) }, { from: 'b', to: 'a', label: 'y'.repeat(27) }] });
    expect(layout.edges[0].label?.text).toBe('x'.repeat(26));
    expect(layout.edges[1].label?.text).toBe(`${'y'.repeat(25)}…`);
  });

  it('keeps both labels of a 2-cycle apart', () => {
    expectReadable(diagram(['a', 'b'], [['a', 'b', 'forward'], ['b', 'a', 'back']]));
  });

  it('draws the closing edge of a 3-cycle as an arc below three separate columns', () => {
    const layout = expectReadable(diagram(['a', 'b', 'c'], [['a', 'b', 'first'], ['b', 'c', 'second'], ['c', 'a', 'closing']]));
    const [a, b, c] = layout.nodes;
    expect(new Set([a.x, b.x, c.x]).size).toBe(3);
    expect(a.x).toBeLessThan(b.x);
    expect(b.x).toBeLessThan(c.x);
    expect(layout.edges[0].path).toBe(nextColumnCurve(a, b));
    expect(layout.edges[1].path).toBe(nextColumnCurve(b, c));
    expect(layout.edges[2].path).not.toBe(nextColumnCurve(c, a));
    expect(Math.max(...ys(layout.edges[2].path))).toBeGreaterThan(c.y + 36);
    expect(layout.edges[2].label!.x).toBeGreaterThan(a.x);
    expect(layout.edges[2].label!.x).toBeLessThan(c.x);
  });

  it('keeps labels readable in a 6-cycle', () => {
    const ids = ['a', 'b', 'c', 'd', 'e', 'f'];
    expectReadable(diagram(ids, ids.map((id, index) => [id, ids[(index + 1) % ids.length], `step ${index + 1}`] as [string, string, string])));
  });

  it('keeps labels readable in a 4-cycle', () => {
    const ids = ['a', 'b', 'c', 'd'];
    expectReadable(diagram(ids, ids.map((id, index) => [id, ids[(index + 1) % ids.length], `step ${index + 1}`] as [string, string, string])));
  });

  it('separates the labels of crossing edges', () => {
    expectReadable(diagram(['a', 'b', 'c', 'd'], [['a', 'd', 'first'], ['b', 'c', 'second']]));
  });

  it('routes a skip edge above the nodes and away from the middle node', () => {
    const layout = expectReadable(diagram(['a', 'b', 'c'], [['a', 'b', 'one'], ['b', 'c', 'two'], ['a', 'c', 'skip']]));
    const skip = layout.edges[2];
    expect(Math.min(...ys(skip.path))).toBeLessThan(layout.nodes[1].y - 36);
    expect(labelBox(skip.label!).b).toBeLessThan(layout.nodes[1].y - 36);
  });

  it('lays out a tree with labelled branches', () => {
    expectReadable(diagram(['s', 'r', 'b', 'rr', 'rb', 'br', 'bb'], [['s', 'r', '26/52'], ['s', 'b', '26/52'], ['r', 'rr', '25/51'], ['r', 'rb', '26/51'], ['b', 'br', '26/51'], ['b', 'bb', '25/51']]));
  });

  it('lays out a 24-node chain with labels', () => {
    const ids = Array.from({ length: 24 }, (_, index) => `n${index}`);
    expectReadable(diagram(ids, ids.slice(1).map((id, index) => [ids[index], id, `after step ${index + 1}`] as [string, string, string])));
  });

  it('keeps self-loops visible, on the bottom row and on an inner row', () => {
    const bottom = expectReadable(diagram(['a'], [['a', 'a', 'retry']]));
    expect(Math.max(...ys(bottom.edges[0].path))).toBeGreaterThan(bottom.nodes[0].y + 36);
    expect(bottom.edges[0].path).toMatch(/[QL]/);
    const inner = expectReadable(diagram(['r', 'a', 'b', 'c', 'd'], [['r', 'a'], ['r', 'b'], ['r', 'c'], ['b', 'b', 'again'], ['b', 'd', 'next']]));
    expect(Math.max(...ys(inner.edges[3].path))).toBeGreaterThan(Math.max(...inner.nodes.map((node) => node.y)) + 36);
  });

  it('gives overlapping arcs separate lanes', () => {
    const ids = ['a', 'b', 'c', 'd'];
    const layout = expectReadable(diagram(ids, [['a', 'b', 'x'], ['b', 'c', 'y'], ['c', 'd', 'z'], ['d', 'a', 'long back'], ['c', 'a', 'short back']]));
    const [outer, inner] = [layout.edges[3].label!, layout.edges[4].label!];
    expect(outer.y).not.toBe(inner.y);
  });

  it('reproduces the unlabelled layout size of a chain', () => {
    const ids = Array.from({ length: 12 }, (_, index) => `s${index}`);
    const layout = layoutDiagram(diagram(ids, ids.slice(1).map((id, index) => [ids[index], id] as [string, string])));
    expect(layout.width).toBe(2760);
    expect(layout.height).toBe(210);
  });

  it('orders rows so that crossing edges are untangled and each label stays by its own arrow', () => {
    const layout = expectReadable(diagram(['a', 'b', 'c', 'd'], [['a', 'd', 'first'], ['b', 'c', 'second']]));
    const [a, b, c, d] = layout.nodes;
    expect(d.y).toBeLessThan(c.y);
    expect(d.y).toBe(a.y);
    expect(c.y).toBe(b.y);
    const [first, second] = [layout.edges[0].label!, layout.edges[1].label!];
    expect(first.y).not.toBe(second.y);
    expect(Math.abs(first.y - a.y)).toBeLessThan(20);
    expect(Math.abs(second.y - b.y)).toBeLessThan(20);
  });

  it('keeps the reading order of a tree and of a chain', () => {
    const tree = layoutDiagram(diagram(['s', 'r', 'b', 'rr', 'rb', 'br', 'bb'], [['s', 'r'], ['s', 'b'], ['r', 'rr'], ['r', 'rb'], ['b', 'br'], ['b', 'bb']]));
    const row = (id: string) => tree.nodes.find((node) => node.id === id)!.y;
    expect([row('r'), row('b')]).toEqual([...[row('r'), row('b')]].sort((x, y) => x - y));
    expect(['rr', 'rb', 'br', 'bb'].map(row)).toEqual(['rr', 'rb', 'br', 'bb'].map(row).sort((x, y) => x - y));
    const chain = layoutDiagram(diagram(['a', 'b', 'c'], [['a', 'b'], ['b', 'c']]));
    expect(new Set(chain.nodes.map((node) => node.y)).size).toBe(1);
  });

  it('keeps a K2,2 readable although its edges must cross', () => {
    const layout = expectReadable(diagram(['a', 'b', 'c', 'd'], [['a', 'c', 'ac'], ['a', 'd', 'ad'], ['b', 'c', 'bc'], ['b', 'd', 'bd']]));
    expect(new Set(layout.edges.map((edge) => edge.label!.y)).size).toBeGreaterThanOrEqual(3);
  });

  it('starts the return from a branch apart from the arrow that arrives there (cell cycle with G0)', () => {
    const layout = expectReadable(diagram(['g1', 'g0', 's', 'g2', 'm'], [
      ['g1', 's', 'phase S'], ['s', 'g2', 'replication faite'], ['g2', 'm', 'mitose'], ['m', 'g1', 'division'],
      ['g1', 'g0', 'sortie du cycle'], ['g0', 'g1', 'signal de croissance'],
    ]));
    const g0 = layout.nodes[1];
    const start = samplePath(layout.edges[5].path)[0];
    expect(start[0]).toBe(g0.x - 84);
    expect(Math.abs(start[1] - g0.y)).toBeGreaterThanOrEqual(14);
    expect(Math.max(...samplePath(layout.edges[5].path).map(([, y]) => y))).toBeGreaterThan(Math.max(...layout.nodes.map((node) => node.y)) + 36);
  });

  it('keeps a water cycle with a branch readable', () => {
    expectReadable(diagram(['evap', 'cond', 'precip', 'runoff', 'infil'], [
      ['evap', 'cond', 'rises and cools'], ['cond', 'precip', 'droplets merge'], ['precip', 'runoff', 'flows downhill'], ['precip', 'infil', 'soaks in'],
      ['runoff', 'evap', 'sun heats water'], ['infil', 'evap', 'springs and plants'],
    ]));
  });

  it('keeps three returning branches of one node apart', () => {
    const layout = expectReadable(diagram(['s', 'p', 'h', 'q', 'x', 'y', 'z'], [
      ['s', 'p'], ['s', 'h'], ['s', 'q'], ['h', 'x'], ['h', 'y'], ['h', 'z'],
      ['x', 'h', 'suite b'], ['y', 'h', 'correction'], ['z', 'h', 'retour'],
    ]));
    const hub = layout.nodes[2];
    const arrivals = [6, 7, 8].map((edge) => { const points = samplePath(layout.edges[edge].path); return points[points.length - 1]; });
    arrivals.forEach((point) => expect(point[0]).toBe(hub.x + 88));
    const returns = [6, 7, 8].map((edge) => samplePath(layout.edges[edge].path));
    returns.forEach((first, index) => returns.slice(index + 1).forEach((second) => expect(crosses(first, second)).toBe(false)));
    const heights = arrivals.map(([, y]) => y).sort((a, b) => a - b);
    expect(heights[1] - heights[0]).toBeGreaterThanOrEqual(9);
    expect(heights[2] - heights[1]).toBeGreaterThanOrEqual(9);
  });

  it('nests returns to one node without crossing, whatever their order, and holds every lane in the canvas', () => {
    const ids = ['a', 'b', 'c', 'd', 'e'];
    const chain = ids.slice(1).map((id, index) => [ids[index], id, `s${index}`] as [string, string, string]);
    const returns: Array<[string, string, string]> = [['e', 'a', 'four'], ['d', 'a', 'three'], ['c', 'a', 'two'], ['b', 'a', 'one']];
    for (const order of [returns, [...returns].reverse()]) {
      const layout = expectReadable(diagram(ids, [...chain, ...order]));
      const arcs = layout.edges.filter((edge) => isArc(edge.path)).map((edge) => samplePath(edge.path));
      expect(arcs).toHaveLength(4);
      arcs.forEach((first, index) => arcs.slice(index + 1).forEach((second) => expect(crosses(first, second)).toBe(false)));
      expect(new Set(layout.edges.slice(4).map((edge) => edge.label!.y)).size).toBe(4);
      expect(layout.height).toBeGreaterThanOrEqual(Math.max(...arcs.flat().map(([, y]) => y)) + 6);
    }
  });

  it('holds three skips above a row inside the canvas', () => {
    const ids = ['a', 'b', 'c', 'd', 'e'];
    const layout = expectReadable(diagram(ids, [['a', 'b', 'x'], ['b', 'c', 'y'], ['c', 'd', 'z'], ['d', 'e', 'w'], ['a', 'c', 'skip 1'], ['b', 'e', 'skip 3'], ['a', 'e', 'long skip']]));
    expect(new Set(layout.edges.slice(4).map((edge) => edge.label!.y)).size).toBe(3);
  });

  it('keeps many self-loops of one column apart and inside the canvas', () => {
    const kids = ['n0', 'n1', 'n2', 'n3', 'n4', 'n5'];
    const layout = expectReadable(diagram(['r', 'm', ...kids], [['r', 'm'], ...kids.map((id) => ['m', id] as [string, string]), ...kids.slice(0, 5).map((id) => [id, id, 'again'] as [string, string, string])]));
    const loops = layout.edges.filter((edge) => isArc(edge.path)).map((edge) => samplePath(edge.path));
    expect(loops).toHaveLength(5);
    loops.forEach((first, index) => loops.slice(index + 1).forEach((second) => expect(crosses(first, second)).toBe(false)));
  });

  it('puts a self-loop label just below its short loop instead of over it', () => {
    const layout = expectReadable(diagram(['a'], [['a', 'a', 'retry']]));
    const loop = samplePath(layout.edges[0].path);
    expect(labelBox(layout.edges[0].label!).t).toBeGreaterThanOrEqual(Math.max(...loop.map(([, y]) => y)));
  });

  it('draws arcs without labels', () => {
    const layout = expectReadable(diagram(['a', 'b', 'c'], [['a', 'b'], ['b', 'c'], ['c', 'a'], ['a', 'c']]));
    expect(layout.edges.every((edge) => edge.label === undefined)).toBe(true);
    expect(layout.edges.filter((edge) => isArc(edge.path))).toHaveLength(2);
  });

  it('routes a skip and a return that start or end on an inner row', () => {
    const layout = expectReadable(diagram(['a', 'b', 'c', 'd', 'e', 'f'], [
      ['a', 'c'], ['c', 'e'], ['a', 'b'], ['b', 'e'], ['a', 'd'], ['d', 'e'], ['e', 'f', 'last'],
      ['c', 'f', 'inner skip'], ['e', 'c', 'inner return'], ['d', 'a', 'bottom return'],
    ]));
    const skip = samplePath(layout.edges[7].path);
    expect(Math.min(...skip.map(([, y]) => y))).toBeLessThan(Math.min(...layout.nodes.map((node) => node.y)) - 36);
    const back = samplePath(layout.edges[8].path);
    expect(Math.max(...back.map(([, y]) => y))).toBeGreaterThan(Math.max(...layout.nodes.map((node) => node.y)) + 36);
  });

  it('keeps a self-loop on an inner row of the last column inside the canvas', () => {
    expectReadable(diagram(['r', 'a', 'b', 'c'], [['r', 'a'], ['r', 'b'], ['r', 'c'], ['b', 'b', 'again']]));
  });

  it('moves everything inward when a label would pass the left edge', () => {
    const layout = expectReadable(diagram(['a', 'b'], [['a', 'a', 'x'.repeat(26)], ['a', 'b', 'next'], ['b', 'a', 'back']]));
    expect(layout.nodes[0].x).toBeGreaterThan(100);
    expect(labelBox(layout.edges[0].label!).l).toBeGreaterThanOrEqual(0);
  });

  it('prefers the roots as the start of the search, so the entry node stays in the first column', () => {
    const layout = expectReadable(diagram(['a', 'r', 'b', 'c'], [['a', 'b', 'ab'], ['b', 'c', 'bc'], ['c', 'a', 'ca'], ['r', 'b', 'rb']]));
    const [a, r, b, c] = layout.nodes;
    expect(r.x).toBeLessThan(b.x);
    expect(b.x).toBeLessThan(c.x);
    expect(c.x).toBeLessThan(a.x);
  });

  it('holds on random graphs, including repeated edges, self-loops and long labels', () => {
    let seed = 12345;
    const next = (bound: number) => { seed = (seed * 1103515245 + 12345) % 2147483648; return Math.floor(seed / 2147483648 * bound); };
    for (let round = 0; round < 150; round++) {
      const ids = Array.from({ length: 1 + next(9) }, (_, index) => `n${index}`);
      const edges = Array.from({ length: next(16) }, () => [ids[next(ids.length)], ids[next(ids.length)], next(3) ? 'k'.repeat(1 + next(30)) : undefined] as [string, string, string | undefined]);
      expectReadable(diagram(ids, edges), false);
    }
  });
});
