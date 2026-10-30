import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useLiveNotes } from './use-live-notes';
import type { Lesson, TranscriptSegment } from '../types';
import type { LLMProvider } from './llm-provider';

const lesson: Lesson = { id: 'l', title: 'Lecture', subject: 'Maths', chapter: '', teacher: '', duration: '', date: '', progress: 0 };
const transcript: TranscriptSegment[] = [
  { id: 'a', start: 0, end: 10, timestamp: '00:00:00', speaker: '', text: 'The calculation uses a smaller step to obtain a more precise approximation. The numerical error decreases when the step is reduced.' },
  { id: 'b', start: 10, end: 15, timestamp: '00:00:10', speaker: '', text: 'An unfinished phrase' },
];
afterEach(() => vi.useRealTimers());

describe('live lecture notes', () => {
  it('drafts a complete passage once, keeping the unstable tail out of the request', async () => {
    vi.useFakeTimers();
    const generate = vi.fn<LLMProvider['generate']>(async () => ({ model: 'test', content: JSON.stringify({ blocks: [{ type: 'markdown', sourceId: 'a', transcriptIds: ['a'], markdown: '## Approximation\n\nA smaller step reduces the numerical error.' }] }) }));
    const provider = { generate };
    const { result } = renderHook(() => useLiveNotes('recording', lesson, transcript, provider));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(result.current.blocks[0]).toMatchObject({ type: 'markdown' });
    expect(generate.mock.calls[0][0][1].content).not.toContain('unfinished');
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
    expect(generate).toHaveBeenCalledTimes(1);
  });
});
