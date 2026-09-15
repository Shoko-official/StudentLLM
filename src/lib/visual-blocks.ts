export type VisualChartType = 'bar' | 'line' | 'pie';

export interface VisualSource {
  sourceId: string;
  sourcePage?: number;
  sourceLabel?: string;
}

export interface VisualChart extends VisualSource {
  type: 'chart';
  chartType: VisualChartType;
  title?: string;
  values: Array<{ label: string; value: number }>;
}

export interface VisualDiagram extends VisualSource {
  type: 'diagram';
  title?: string;
  nodes: Array<{ id: string; label: string }>;
  edges: Array<{ from: string; to: string; label?: string }>;
}

export interface VisualTable extends VisualSource {
  type: 'table';
  title?: string;
  columns: string[];
  rows: string[][];
}

export type VisualBlock = VisualChart | VisualDiagram | VisualTable;

const visualTypes = new Set(['chart', 'diagram', 'table']);
const chartTypes = new Set<VisualChartType>(['bar', 'line', 'pie']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function cleanText(value: unknown, maxLength = 240) {
  if (typeof value !== 'string') return null;
  const text = value.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (!text || text.length > maxLength || /<\/?script\b|javascript:/i.test(text)) return null;
  return text;
}

function sourceFields(value: Record<string, unknown>, sourceIds: Set<string>) {
  const sourceId = cleanText(value.sourceId, 160);
  if (!sourceId || !sourceIds.has(sourceId)) return null;
  const sourcePage = value.sourcePage === undefined
    ? undefined
    : typeof value.sourcePage === 'number' && Number.isInteger(value.sourcePage) && value.sourcePage > 0
      ? value.sourcePage
      : null;
  if (sourcePage === null) return null;
  const sourceLabel = value.sourceLabel === undefined ? undefined : cleanText(value.sourceLabel, 180);
  if (value.sourceLabel !== undefined && !sourceLabel) return null;
  return { sourceId, ...(sourcePage === undefined ? {} : { sourcePage }), ...(sourceLabel ? { sourceLabel } : {}) };
}

function parseChart(value: Record<string, unknown>, sourceIds: Set<string>): VisualChart | null {
  const source = sourceFields(value, sourceIds);
  const chartType = value.chartType;
  const rawValues = value.values;
  if (!source || typeof chartType !== 'string' || !chartTypes.has(chartType as VisualChartType) || !Array.isArray(rawValues) || rawValues.length < 2 || rawValues.length > 32) return null;
  const values = rawValues.map((item) => {
    if (!isRecord(item)) return null;
    const label = cleanText(item.label, 80);
    const numericValue = typeof item.value === 'number' ? item.value : null;
    return label && numericValue !== null && Number.isFinite(numericValue) ? { label, value: numericValue } : null;
  });
  if (values.some((item) => item === null)) return null;
  const title = value.title === undefined ? undefined : cleanText(value.title, 180);
  if (value.title !== undefined && !title) return null;
  return { type: 'chart', chartType: chartType as VisualChartType, ...(title ? { title } : {}), ...source, values: values as Array<{ label: string; value: number }> };
}

function parseDiagram(value: Record<string, unknown>, sourceIds: Set<string>): VisualDiagram | null {
  const source = sourceFields(value, sourceIds);
  const rawNodes = value.nodes;
  const rawEdges = value.edges;
  if (!source || !Array.isArray(rawNodes) || rawNodes.length < 1 || rawNodes.length > 48 || !Array.isArray(rawEdges) || rawEdges.length > 96) return null;
  const nodes = rawNodes.map((item) => {
    if (!isRecord(item)) return null;
    const id = cleanText(item.id, 80);
    const label = cleanText(item.label, 160);
    return id && label ? { id, label } : null;
  });
  if (nodes.some((item) => item === null)) return null;
  const nodeIds = new Set(nodes.map((node) => node!.id));
  const edges = rawEdges.map((item) => {
    if (!isRecord(item)) return null;
    const from = cleanText(item.from, 80);
    const to = cleanText(item.to, 80);
    const label = item.label === undefined ? undefined : cleanText(item.label, 120);
    return from && to && nodeIds.has(from) && nodeIds.has(to) && (item.label === undefined || label) ? { from, to, ...(label ? { label } : {}) } : null;
  });
  if (edges.some((item) => item === null)) return null;
  const title = value.title === undefined ? undefined : cleanText(value.title, 180);
  if (value.title !== undefined && !title) return null;
  return { type: 'diagram', ...(title ? { title } : {}), ...source, nodes: nodes as Array<{ id: string; label: string }>, edges: edges as Array<{ from: string; to: string; label?: string }> };
}

function parseTable(value: Record<string, unknown>, sourceIds: Set<string>): VisualTable | null {
  const source = sourceFields(value, sourceIds);
  const rawColumns = value.columns;
  const rawRows = value.rows;
  if (!source || !Array.isArray(rawColumns) || rawColumns.length < 1 || rawColumns.length > 16 || !Array.isArray(rawRows) || rawRows.length > 64) return null;
  const columns = rawColumns.map((column) => cleanText(column, 120));
  if (columns.some((column) => !column)) return null;
  const rows = rawRows.map((row) => Array.isArray(row) && row.length === columns.length ? row.map((cell) => cleanText(cell, 240)) : null);
  if (rows.some((row) => !row || row.some((cell) => !cell))) return null;
  const title = value.title === undefined ? undefined : cleanText(value.title, 180);
  if (value.title !== undefined && !title) return null;
  return { type: 'table', ...(title ? { title } : {}), ...source, columns: columns as string[], rows: rows as string[][] };
}

export function parseVisualEnvelope(content: string, sourceIds: Set<string>): VisualBlock[] | null {
  const candidates = [
    content.trim(),
    content.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1] ?? '',
    content.match(/\{[\s\S]*\}/)?.[0] ?? '',
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (!isRecord(parsed) || !Array.isArray(parsed.visuals)) continue;
      const visuals = parsed.visuals.map((item) => {
        if (!isRecord(item) || typeof item.type !== 'string' || !visualTypes.has(item.type)) return null;
        if (item.type === 'chart') return parseChart(item, sourceIds);
        if (item.type === 'diagram') return parseDiagram(item, sourceIds);
        return parseTable(item, sourceIds);
      });
      if (visuals.some((item) => item === null)) return null;
      return visuals as VisualBlock[];
    } catch {
      // Try the next common provider wrapper.
    }
  }
  return null;
}
