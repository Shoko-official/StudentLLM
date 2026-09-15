import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { parseVisualEnvelope, type VisualBlock } from './visual-blocks';
import { VisualBlockView } from './visual-blocks-view';

describe('visual block protocol', () => {
  it('accepts source-linked charts, diagrams, and tables', () => {
    const visuals = parseVisualEnvelope(JSON.stringify({
      visuals: [
        {
          type: 'chart',
          chartType: 'pie',
          title: 'Distribution',
          sourceId: 'page-2',
          values: [{ label: 'A', value: 2 }, { label: 'B', value: 3 }],
        },
        {
          type: 'diagram',
          title: 'Pipeline',
          sourceId: 'page-2',
          nodes: [{ id: 'input', label: 'Input' }, { id: 'output', label: 'Output' }],
          edges: [{ from: 'input', to: 'output', label: 'flows to' }],
        },
        {
          type: 'table',
          title: 'Values',
          sourceId: 'page-2',
          columns: ['Name', 'Value'],
          rows: [['A', '2'], ['B', '3']],
        },
      ],
    }), new Set(['page-2']));

    expect(visuals).toHaveLength(3);
    expect(visuals?.[0]).toMatchObject({ type: 'chart', chartType: 'pie', sourceId: 'page-2' });
    expect(visuals?.[1]).toMatchObject({ type: 'diagram', edges: [{ from: 'input', to: 'output' }] });
    expect(visuals?.[2]).toMatchObject({ type: 'table', columns: ['Name', 'Value'] });
  });

  it('rejects visuals that are unlinked or contain executable payloads', () => {
    expect(parseVisualEnvelope(JSON.stringify({ visuals: [{
      type: 'diagram',
      sourceId: 'missing',
      nodes: [{ id: 'a', label: '<script>alert(1)</script>' }],
      edges: [],
    }] }), new Set(['page-1']))).toBeNull();
  });

  it('keeps source provenance on normalized blocks', () => {
    const visuals = parseVisualEnvelope(JSON.stringify({ visuals: [{
      type: 'chart',
      chartType: 'bar',
      sourceId: 'page-1',
      sourcePage: 1,
      values: [{ label: 'one', value: 1 }, { label: 'two', value: 2 }],
    }] }), new Set(['page-1'])) as VisualBlock[];

    expect(visuals[0]).toMatchObject({ sourceId: 'page-1', sourcePage: 1 });
  });

  it('renders charts, diagrams, and tables as inspectable accessible content', () => {
    const visuals = parseVisualEnvelope(JSON.stringify({ visuals: [
      { type: 'chart', chartType: 'bar', title: 'Scores', sourceId: 'page-1', values: [{ label: 'A', value: 4 }, { label: 'B', value: 2 }] },
      { type: 'diagram', title: 'Flow', sourceId: 'page-1', nodes: [{ id: 'a', label: 'Start' }, { id: 'b', label: 'End' }], edges: [{ from: 'a', to: 'b', label: 'next' }] },
      { type: 'table', title: 'Inputs', sourceId: 'page-1', columns: ['Name', 'Value'], rows: [['x', '1']] },
    ] }), new Set(['page-1'])) as VisualBlock[];

    render(<>{visuals.map((visual, index) => <VisualBlockView key={index} visual={visual} />)}</>);

    expect(screen.getByRole('img', { name: /Scores/ })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: /Flow/ })).toBeInTheDocument();
    expect(screen.getByRole('table', { name: 'Inputs' })).toBeInTheDocument();
    expect(screen.getByText('Start')).toBeInTheDocument();
    expect(screen.getByText('next')).toBeInTheDocument();
  });
});
