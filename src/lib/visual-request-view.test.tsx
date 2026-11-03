import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RichText } from './rich-text';
import { VisualJobsContext } from './visual-request-view';

const content = 'Text.\n\n```student-visual-request\n{"id":"v1","type":"quiz","intent":"Check the idea","content":"C"}\n```';
const renderWith = (isPending: boolean, retry = vi.fn()) => {
  render(<VisualJobsContext.Provider value={{ isPending: () => isPending, retry }}><RichText content={content} messageId="m1" allowTeachingVisuals /></VisualJobsContext.Provider>);
  return retry;
};

describe('visual request rendering', () => {
  it('shows a status and no retry while the job runs', () => {
    renderWith(true);
    expect(screen.getByRole('status')).toHaveTextContent('Preparing a visual: Check the idea');
    expect(screen.queryByRole('button', { name: 'Retry this visual' })).toBeNull();
  });

  it('offers a retry for a request with no running job', async () => {
    const retry = renderWith(false);
    expect(screen.getByText('This visual was not generated: Check the idea')).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Retry this visual' }));
    expect(retry).toHaveBeenCalledWith('m1', 'v1');
  });

  it('shows no retry when no provider can run it, and keeps user content inert', () => {
    render(<RichText content={content} messageId="m1" allowTeachingVisuals />);
    expect(screen.getByText('This visual was not generated: Check the idea')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry this visual' })).toBeNull();
    const { container } = render(<RichText content={content} />);
    expect(container.querySelector('code.language-student-visual-request')).toBeInTheDocument();
  });

  it('never renders a malformed request as an active control', () => {
    const { container } = render(<RichText content={'```student-visual-request\n{broken\n```'} messageId="m1" allowTeachingVisuals />);
    expect(screen.queryByRole('button')).toBeNull();
    expect(container).toHaveTextContent('This visual was not generated');
  });

  it('keeps the state of a finished visual when another visual of the same answer arrives', () => {
    const plot = { type: 'plot', title: 'P', x: { min: 0, max: 1 }, parameters: [{ name: 'a', label: 'Coefficient', min: 0, max: 4, step: 1, value: 1 }], series: [{ label: 'y', expression: 'a*x' }] };
    const quiz = { type: 'quiz', title: 'Q', question: 'Q?', options: ['A', 'B'], answer: 0, explanation: 'E' };
    const finished = '```student-visual\n' + JSON.stringify(plot) + '\n```\n\nText.\n\n';
    const { rerender } = render(<RichText content={finished + content} messageId="m1" allowTeachingVisuals />);
    fireEvent.change(screen.getByRole('slider', { name: /Coefficient/ }), { target: { value: '3' } });
    rerender(<RichText content={finished + '```student-visual\n' + JSON.stringify(quiz) + '\n```'} messageId="m1" allowTeachingVisuals />);
    expect(screen.getByRole('slider', { name: /Coefficient/ })).toHaveValue('3');
    expect(screen.getByText('Q?')).toBeInTheDocument();
  });
});
