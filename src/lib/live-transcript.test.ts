import { describe, expect, it } from 'vitest';
import { groupTranscript, mergeLiveWindow, speakerLabel } from './live-transcript';
import type { TranscriptSegment } from '../types';

const segment = (id: string, start: number, end: number, text: string, speaker = 'Speaker'): TranscriptSegment => ({
  id, start, end, timestamp: `00:00:${String(start).padStart(2, '0')}`, text, speaker, sourceId: 'recording',
});

describe('readable live transcription', () => {
  it('does not present decoder chunks as different speakers', () => {
    const groups = groupTranscript([segment('a', 0, 4, 'The method'), segment('b', 4, 9, 'uses a smaller step.')]);
    expect(groups).toHaveLength(1);
    expect(groups[0].text).toBe('The method uses a smaller step.');
    expect(speakerLabel(groups[0].speaker)).toBe('');
    expect(speakerLabel('Speaker 2')).toBe('Speaker 2');
  });

  it('preserves real speaker changes, pauses and source boundaries', () => {
    expect(groupTranscript([segment('a', 0, 4, 'Question', 'Alice'), segment('b', 4, 8, 'Answer', 'Bob')])).toHaveLength(2);
    expect(groupTranscript([segment('a', 0, 4, 'First.'), segment('b', 20, 24, 'Next.')])).toHaveLength(2);
    expect(groupTranscript([segment('a', 0, 4, 'First.'), { ...segment('b', 4, 8, 'Next.'), sourceId: 'other' }])).toHaveLength(2);
  });

  it('revises only the overlapping tail and keeps earlier speech once', () => {
    const previous = [segment('a', 0, 4, 'Earlier.'), segment('b', 4, 7, 'The error is')];
    const next = mergeLiveWindow(previous, [segment('new', 0, 5, 'The error is quadratic.')], { start: 4, end: 12 }, 'recording');
    expect(next.segments.map(s => s.text)).toEqual(['Earlier.', 'The error is quadratic.']);
    expect(next.segments[1]).toMatchObject({ start: 4, end: 9, timestamp: '00:00:04' });
    expect(next.nextStart).toBeGreaterThanOrEqual(9);
  });

  it('keeps a boundary-spanning sentence available for revision', () => {
    const next = mergeLiveWindow([], [segment('a', 0, 5, 'First.'), segment('b', 5, 12, 'Unfinished sentence')], { start: 0, end: 12 }, 'recording');
    expect(next.nextStart).toBe(5);
    expect(next.segments).toHaveLength(2);
  });

  it('advances through silence without repeating the previous passage', () => {
    const next = mergeLiveWindow([segment('a', 0, 4, 'Earlier.')], [], { start: 4, end: 28 }, 'recording');
    expect(next.segments.map(s => s.text)).toEqual(['Earlier.']);
    expect(next.nextStart).toBe(26);
  });
  it('retains the beginning of a word crossing the window cutoff', () => {
    const input = { ...segment('long', 0, 24, 'A partialword'), words: [{ start: 0, end: 21.5, word: ' A' }, { start: 21.5, end: 24, word: ' partialword' }] };
    const next = mergeLiveWindow([], [input], { start: 0, end: 24 }, 'recording');
    expect(next.nextStart).toBe(21.5);
    expect(next.segments[0].text).toBe('A');
  });
});
