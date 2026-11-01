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

function expectReadable(visual: TeachingDiagram) {
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
  return layout;
}

const nextColumnCurve = (from: { x: number; y: number }, to: { x: number; y: number }) => {
  const x1 = from.x + 84, x2 = to.x - 88;
  return `M${x1} ${from.y} C${x1 + 55} ${from.y},${x2 - 55} ${to.y},${x2} ${to.y}`;
};
const ys = (path: string) => (path.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number).filter((_, index) => index % 2 === 1);

describe('diagram layout', () => {
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
});
